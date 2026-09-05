import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENTRYPOINT_NAME, ensureMemoryDirExists, getAutoMemEntrypoint, getAutoMemPath, isAutoMemPath } from "./memdir.js";
import {
	MEMORY_FRONTMATTER_EXAMPLE,
	TYPES_SECTION_INDIVIDUAL,
	WHAT_NOT_TO_SAVE_SECTION,
} from "./memoryTypes.js";
import { formatMemoryManifest, scanMemoryFiles, type MemoryHeader } from "./memoryScan.js";
const ENV_ENABLE = "PICC_MEMORY_EXTRACTION";
const ENV_INTERVAL = "PICC_MEMORY_EXTRACTION_INTERVAL";
const ENV_MAX_TURNS = "PICC_MEMORY_EXTRACTION_MAX_TURNS";
const ENV_MODEL = "PICC_MEMORY_EXTRACTION_MODEL";
const RPC_PING = "subagents:rpc:ping";
const RPC_SPAWN = "subagents:rpc:spawn";
const ENV_LOG = "PICC_MEMORY_DEBUG";
const NO_CURSOR: string | undefined = undefined;
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
		return messages.filter(isModelVisible).length;
	}
	return n;
}
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
async function runExtraction(
	pi: ExtensionAPI,
	state: ExtractorState,
	ctx: ExtensionContext,
): Promise<void> {
	const cwd = ctx.cwd;
	const messages = collectBranchMessages(ctx);
	const interval = readInterval();
	const newCount = countMessagesSince(messages, state.lastMessageUuid);
	if (hasMemoryWritesSince(messages, state.lastMessageUuid, cwd)) {
		log(pi, "[picc-memory] skipping extraction — main agent wrote memory files");
		advanceCursor(messages, state);
		return;
	}
	state.turnsSinceLastRun += 1;
	if (state.turnsSinceLastRun < interval) return;
	state.turnsSinceLastRun = 0;
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
		console.log(message);
	}
	try {
		(pi.events as unknown as { emit?: (e: string, d: unknown) => void }).emit?.(
			"picc-memory:debug",
			{ message, ts: Date.now() },
		);
	} catch {
	}
}
export interface ExtractorHandle {
	schedule: (ctx: ExtensionContext) => void;
	drain: (timeoutMs?: number) => Promise<void>;
	enabled: boolean;
}
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
			await new Promise<void>(resolve => {
				const t = setTimeout(resolve, timeoutMs);
				t.unref();
			});
			await Promise.allSettled([...state.inFlight]);
		},
	};
}
export { getAutoMemEntrypoint };
