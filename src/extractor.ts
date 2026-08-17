/**
 * Background forked extraction.
 *
 * Replicates claude-code/services/extractMemories/extractMemories.ts with
 * the following design choices for pi:
 *
 *   - The forked subagent is spawned via pi-subagents' cross-extension RPC
 *     (`subagents:rpc:spawn`). If pi-subagents is not installed, we ship
 *     a graceful no-op and emit a one-shot debug notice; the main agent
 *     saves memories on explicit user request via its own tools, so the
 *     system still works.
 *
 *   - pi-subagents does NOT expose a per-spawn tool allowlist; the spawned
 *     agent gets full Read/Write/Edit tools by default. We compensate with
 *     strong system-prompt instructions ("only write to <memoryDir>") in
 *     the extraction prompt. This is the same trade-off Claude Code's
 *     extraction prompt makes — the `canUseTool` filter is belt-and-
 *     suspenders over a prompt that's already restrictive.
 *
 *   - Extractor is opt-in via PICC_MEMORY_EXTRACTION=1 (off by default).
 *     Background extraction costs tokens (a model call per turn on the
 *     default throttle of 1) and can be noisy in tight loops. Users who
 *     want Claude Code's behavior explicitly opt in.
 *
 *   - Throttle: every N eligible turns (default 1, configurable via
 *     PICC_MEMORY_EXTRACTION_INTERVAL). Mutual exclusion: skip if the
 *     main agent already wrote memory files in this range — both paths
 *     shouldn't fire on the same messages.
 *
 *   - Trailing run coalescing: if a new extraction arrives while one is
 *     in flight, stash the latest context and re-run after completion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENTRYPOINT_NAME, ensureMemoryDirExists, getAutoMemEntrypoint, getAutoMemPath, isAutoMemPath } from "./memdir.js";
import {
	MEMORY_FRONTMATTER_EXAMPLE,
	TYPES_SECTION_INDIVIDUAL,
	WHAT_NOT_TO_SAVE_SECTION,
} from "./memoryTypes.js";
import { formatMemoryManifest, scanMemoryFiles, type MemoryHeader } from "./memoryScan.js";

// ============================================================================
// Configuration
// ============================================================================

const ENV_ENABLE = "PICC_MEMORY_EXTRACTION";        // off by default
const ENV_INTERVAL = "PICC_MEMORY_EXTRACTION_INTERVAL"; // throttle, default 1
const ENV_MAX_TURNS = "PICC_MEMORY_EXTRACTION_MAX_TURNS"; // default 5
const ENV_MODEL = "PICC_MEMORY_EXTRACTION_MODEL";   // optional, falls back to parent
const RPC_PING = "subagents:rpc:ping";
const RPC_SPAWN = "subagents:rpc:spawn";
const ENV_LOG = "PICC_MEMORY_DEBUG";

/** Initial UUID marker (no messages processed yet). Matches cu -1 in cc. */
const NO_CURSOR: string | undefined = undefined;

// ============================================================================
// State (closure-captured, mirrors claude-code's initExtractMemories pattern)
// ============================================================================

interface ExtractorState {
	inProgress: boolean;
	turnsSinceLastRun: number;
	lastMessageUuid: string | undefined;
	pending: { ctx: ExtensionContext } | undefined;
	hasLoggedSkillMissing: boolean;
	hasLoggedDisabled: boolean;
	inFlight: Set<Promise<void>>;
}

function freshState(): ExtractorState {
	return {
		inProgress: false,
		turnsSinceLastRun: 0,
		lastMessageUuid: NO_CURSOR,
		pending: undefined,
		hasLoggedSkillMissing: false,
		hasLoggedDisabled: false,
		inFlight: new Set(),
	};
}

// ============================================================================
// Message counting (model-visible only)
// ============================================================================

function isModelVisible(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { type?: string; role?: string };
	return m.type === "message" && (m.role === "user" || m.role === "assistant");
}

function countMessagesSince(
	messages: unknown[],
	sinceUuid: string | undefined,
): number {
	if (sinceUuid === undefined) {
		return messages.filter(isModelVisible).length;
	}
	let started = false;
	let n = 0;
	for (const message of messages) {
		if (!started) {
			const m = message as { uuid?: string };
			if (m.uuid === sinceUuid) started = true;
			continue;
		}
		if (isModelVisible(message)) n++;
	}
	if (!started) {
		// Cursor disappeared (compaction, /clear) — fall back to counting all
		// visible messages rather than returning 0, which would silently
		// disable extraction for the rest of the session.
		return messages.filter(isModelVisible).length;
	}
	return n;
}

/**
 * Did the main agent write to any auto-memory path since the cursor?
 * Returns true iff a Write/Edit tool_use block hit a file under
 * getAutoMemPath(cwd). Mutates the messages array (read-only OK because
 * we only check, never mutate).
 */
function hasMemoryWritesSince(
	messages: unknown[],
	sinceUuid: string | undefined,
	cwd: string,
): boolean {
	let started = sinceUuid === undefined;
	for (const message of messages) {
		if (!started) {
			const m = message as { uuid?: string };
			if (m.uuid === sinceUuid) started = true;
			continue;
		}
		const m = message as { type?: string; role?: string; message?: unknown };
		if (m.type !== "message" || m.role !== "assistant") continue;
		const inner = m.message as { content?: unknown } | undefined;
		if (!inner || !Array.isArray(inner.content)) continue;
		for (const block of inner.content) {
			const b = block as { type?: string; name?: string; input?: unknown };
			if (b.type !== "tool_use") continue;
			if (b.name !== "write" && b.name !== "edit") continue;
			const input = b.input as { file_path?: unknown } | undefined;
			if (input && typeof input.file_path === "string" && isAutoMemPath(input.file_path, cwd)) {
				return true;
			}
		}
	}
	return false;
}

// ============================================================================
// Prompt building
// ============================================================================

/**
 * Build the canonical extraction prompt. Source of truth:
 * claude-code/services/extractMemories/prompts.ts buildExtractAutoOnlyPrompt().
 *
 * Notable alignment with CC:
 *   - opener matches verbatim (after substituting picc's tool names)
 *   - "Available tools: …" line matches CC; picc-specific MEMORY_BLOCK_RESTRICTION
 *     is dropped (CC's rely on the prompt + the canUseTool belt-and-suspenders;
 *     picc relies on prompt only)
 *   - howToSave block matches CC's two-step pattern
 *   - WHEN_TO_ACCESS_SECTION + TRUSTING_RECALL_SECTION are NOT included —
 *     those are recall-side guidance for the main agent, not the extraction
 *     sub-agent (CC's extraction prompt also omits them)
 */
function buildExtractPrompt(newMessageCount: number, existingMemories: string): string {
	const opener = [
		`You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory systems.`,
		"",
		`Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only. Bash rm is not permitted. All other tools — MCP, Agent, write-capable Bash, etc — will be denied.`,
		"",
		"You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 — issue all Read calls in parallel for every file you might update; turn 2 — issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.",
		"",
		`You MUST only use content from the last ~${newMessageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
			(existingMemories
				? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
				: ""),
	].join("\n");

	const howToSave = [
		"## How to save memories",
		"",
		"Saving a memory is a two-step process:",
		"",
		"**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
		"",
		...MEMORY_FRONTMATTER_EXAMPLE,
		"",
		`**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
		"",
		`- \`${ENTRYPOINT_NAME}\` is always loaded into your system prompt — lines after 200 will be truncated, so keep the index concise`,
		"- Organize memory semantically by topic, not chronologically",
		"- Update or remove memories that turn out to be wrong or outdated",
		"- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
	];

	return [
		opener,
		"",
		"If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
		"",
		...TYPES_SECTION_INDIVIDUAL,
		...WHAT_NOT_TO_SAVE_SECTION,
		"",
		...howToSave,
	].join("\n");
}

// ============================================================================
// RPC plumbing
// ============================================================================

interface RpcEnvelope<T> {
	requestId: string;
	params: T;
}

type RpcReply<T = unknown> =
	| { success: true; data?: T }
	| { success: false; error: string };

let requestSeq = 0;

function nextRequestId(): string {
	requestSeq += 1;
	return `picc-mem-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

function rpcCall<TParams, TData>(
	pi: ExtensionAPI,
	channel: string,
	params: TParams,
	timeoutMs = 30_000,
): Promise<TData> {
	const requestId = nextRequestId();
	const events = pi.events as unknown as {
		on: (event: string, handler: (data: unknown) => void) => () => void;
		emit: (event: string, data: unknown) => void;
	};
	const replyChannel = `${channel}:reply:${requestId}`;

	return new Promise<TData>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`picc-memory: RPC ${channel} timed out after ${timeoutMs}ms (is pi-subagents installed?)`));
		}, timeoutMs);

		const unsub = events.on(replyChannel, (raw: unknown) => {
			clearTimeout(timer);
			unsub();
			const reply = raw as RpcReply<TData>;
			if (reply.success) resolve((reply.data ?? (undefined as unknown)) as TData);
			else reject(new Error(reply.error));
		});

		events.emit(channel, { requestId, params } satisfies RpcEnvelope<TParams>);
	});
}

async function pingSubagents(pi: ExtensionAPI): Promise<boolean> {
	try {
		await rpcCall<Record<string, never>, { version: number }>(pi, RPC_PING, {});
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Extractor
// ============================================================================

async function runExtraction(
	pi: ExtensionAPI,
	state: ExtractorState,
	ctx: ExtensionContext,
): Promise<void> {
	const cwd = ctx.cwd;
	const messages = collectBranchMessages(ctx);
	const interval = readInterval();

	const newCount = countMessagesSince(messages, state.lastMessageUuid);

	// Mutual exclusion: if the main agent already wrote, skip and advance
	// the cursor so we don't double-process those messages next time.
	if (hasMemoryWritesSince(messages, state.lastMessageUuid, cwd)) {
		log(pi, "[picc-memory] skipping extraction — main agent wrote memory files");
		advanceCursor(messages, state);
		return;
	}

	// Throttle: only run every N eligible turns. Use turns-since-last-run
	// (resets after each run, including this one).
	state.turnsSinceLastRun += 1;
	if (state.turnsSinceLastRun < interval) return;
	state.turnsSinceLastRun = 0;

	// Build the manifest of existing topic files so the fork doesn't burn
	// turns on `ls`.
	const memoryDir = getAutoMemPath(cwd);
	ensureMemoryDirExists(cwd);
	const headers: MemoryHeader[] = scanMemoryFiles(memoryDir);
	const existingMemories = formatMemoryManifest(headers);

	const promptText = buildExtractPrompt(newCount, existingMemories);
	const inheritContextText = buildInheritContext(messages, state.lastMessageUuid);
	const fullPrompt = inheritContextText
		? `${inheritContextText}\n\n# Extraction Instructions (below)\n${promptText}`
		: promptText;

	state.inProgress = true;
	try {
		const maxTurns = readMaxTurns();
		const model = readModel();

		log(pi, `[picc-memory] spawning extraction fork (${newCount} new messages, maxTurns=${maxTurns})`);

		const { id } = await rpcCall<RpcSpawnParams, { id: string }>(pi, RPC_SPAWN, {
			type: "general-purpose",
			prompt: fullPrompt,
			options: {
				description: "Memory extraction",
				maxTurns,
				bypassQueue: true,
				isBackground: true,
				isolated: true,
				model,
				cwd,
			},
		});

		log(pi, `[picc-memory] extraction fork spawned: ${id}`);
		// Cursor advances AFTER the spawn — pi-subagents takes over from here.
		advanceCursor(messages, state);
	} catch (err) {
		log(pi, `[picc-memory] extraction failed: ${(err as Error).message}`);
	} finally {
		state.inProgress = false;
		const pending = state.pending;
		state.pending = undefined;
		if (pending) {
			log(pi, "[picc-memory] running trailing extraction");
			await runExtraction(pi, state, pending.ctx);
		}
	}
}

interface RpcSpawnParams {
	type: string;
	prompt: string;
	options: {
		description: string;
		maxTurns: number;
		bypassQueue: boolean;
		isBackground: boolean;
		isolated: boolean;
		model: string | undefined;
		cwd: string;
	};
}

// ============================================================================
// Helpers
// ============================================================================

function collectBranchMessages(ctx: ExtensionContext): unknown[] {
	try {
		const sm = ctx.sessionManager as { getBranch?: () => unknown[] } | undefined;
		if (!sm || typeof sm.getBranch !== "function") return [];
		return sm.getBranch() ?? [];
	} catch {
		return [];
	}
}

function advanceCursor(messages: unknown[], state: ExtractorState): void {
	const last = messages.at(-1);
	if (last && typeof last === "object" && "uuid" in last) {
		state.lastMessageUuid = (last as { uuid: string }).uuid;
	}
}

function buildInheritContext(messages: unknown[], sinceUuid: string | undefined): string {
	if (messages.length === 0) return "";
	const parts: string[] = [];
	let started = sinceUuid === undefined;
	for (const message of messages) {
		if (!started) {
			const m = message as { uuid?: string };
			if (m.uuid === sinceUuid) started = true;
			continue;
		}
		const m = message as { type?: string; role?: string; message?: unknown };
		if (m.type !== "message") continue;
		const inner = m.message as { content?: unknown; role?: string } | undefined;
		if (!inner) continue;
		const text = extractText(inner.content);
		if (!text.trim()) continue;
		const tag = inner.role === "user" ? "User" : inner.role === "assistant" ? "Assistant" : "Other";
		parts.push(`[${tag}]: ${text.trim()}`);
	}
	if (parts.length === 0) return "";
	return `# Recent Conversation (last ${parts.length} messages)\n\n${parts.join("\n\n")}`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: unknown) => {
			if (!c || typeof c !== "object") return false;
			return (c as { type?: string }).type === "text";
		})
		.map((c: unknown) => (c as { text?: unknown }).text ?? "")
		.join("\n");
}

function readInterval(): number {
	const raw = process.env[ENV_INTERVAL]?.trim();
	if (!raw) return 1;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 1 ? n : 1;
}

function readMaxTurns(): number {
	const raw = process.env[ENV_MAX_TURNS]?.trim();
	if (!raw) return 5;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 1 ? n : 5;
}

function readModel(): string | undefined {
	const raw = process.env[ENV_MODEL]?.trim();
	return raw || undefined;
}

function log(pi: ExtensionAPI, message: string): void {
	if (process.env[ENV_LOG] === "1" || process.env[ENV_LOG] === "true") {
		// eslint-disable-next-line no-console
		console.log(message);
	}
	// Emit a lightweight pi-events event so other extensions can observe
	// extractor activity. No-op for listeners that don't exist.
	try {
		(pi.events as unknown as { emit?: (e: string, d: unknown) => void }).emit?.(
			"picc-memory:debug",
			{ message, ts: Date.now() },
		);
	} catch {
		// ignore — events is best-effort
	}
}

// ============================================================================
// Public API
// ============================================================================

export interface ExtractorHandle {
	/**
	 * Hook from agent_end. Schedules an extraction pass if eligible.
	 * Fire-and-forget — never throws into the agent loop.
	 */
	schedule: (ctx: ExtensionContext) => void;
	/**
	 * Hook from session_shutdown. Awaits any in-flight extraction with a
	 * soft timeout (default 60s). Best-effort.
	 */
	drain: (timeoutMs?: number) => Promise<void>;
	/** True when the extractor is enabled (env flag set + pi-subagents installed). */
	enabled: boolean;
}

/**
 * Initialise the extraction system. Returns a handle the caller wires into
 * agent_end / session_shutdown. State is closure-captured so multiple
 * sessions can coexist without bleeding into each other.
 */
export async function initExtractor(pi: ExtensionAPI): Promise<ExtractorHandle> {
	const enabled = process.env[ENV_ENABLE] === "1" || process.env[ENV_ENABLE] === "true";
	if (!enabled) {
		return {
			enabled: false,
			schedule: () => {},
			drain: async () => {},
		};
	}

	const installed = await pingSubagents(pi);
	if (!installed) {
		// eslint-disable-next-line no-console
		console.warn(
			"[picc-memory] PICC_MEMORY_EXTRACTION=1 but pi-subagents is not installed. Disabling extraction — the main agent still saves memories on explicit user request.",
		);
		return {
			enabled: false,
			schedule: () => {},
			drain: async () => {},
		};
	}

	const state = freshState();

	return {
		enabled: true,
		schedule(ctx: ExtensionContext) {
			const p = runExtraction(pi, state, ctx).catch(err => {
				log(pi, `[picc-memory] schedule error: ${(err as Error).message}`);
			});
			state.inFlight.add(p);
			p.finally(() => state.inFlight.delete(p));
		},
		async drain(timeoutMs = 60_000) {
			if (state.inFlight.size === 0) return;
			// setTimeout().unref() is fine; Node types accept it. Cast to
			// `unknown as Timer` because the `.unref()` declaration is on
			// the NodeJS namespace, not on the DOM Timer — the cast keeps
			// strict mode happy without pulling in @types/node globally.
			await new Promise<void>(resolve => {
				const t = setTimeout(resolve, timeoutMs);
				t.unref();
			});
			await Promise.allSettled([...state.inFlight]);
		},
	};
}

// Re-export so callers (e.g. /memory notifications) can display the entrypoint name.
export { getAutoMemEntrypoint };
