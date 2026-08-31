/**
 * CLAUDE.md file discovery + system-prompt building.
 *
 * Adapted from claude-code/utils/claudemd.ts with the following simplifications:
 *   - No marked Lexer / HTML comment stripping.
 *   - No @include directive resolution.
 *   - No conditional rules (paths: frontmatter glob-matching).
 *   - No claudeMdExcludes setting.
 *   - No symlink loop detection (caller can short-circuit via isSymlink()).
 *   - No settings.json source gating (pi's isProjectTrusted() is sufficient).
 *
 * Loading order (reverse priority — later = higher = appears later in
 * context where the LLM pays more attention):
 *   1. Managed CLAUDE.md + /etc/claude-code/rules/*.md
 *   2. User CLAUDE.md + ~/.claude/rules/*.md
 *   3. Project CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md (walk up)
 *   4. Local CLAUDE.local.md (walk up)
 *   5. AutoMem MEMORY.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { ensureMemoryDirExists, truncateEntrypointContent, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES, DIR_EXISTS_GUIDANCE, AUTO_MEM_DISPLAY_NAME } from "./memdir.js";
import {
	MEMORY_FRONTMATTER_EXAMPLE,
	TYPES_SECTION_INDIVIDUAL,
	TRUSTING_RECALL_SECTION,
	WHEN_TO_ACCESS_SECTION,
	WHAT_NOT_TO_SAVE_SECTION,
} from "./memoryTypes.js";
import {
	getAutoMemEntrypoint,
	getAutoMemPath,
	getManagedClaudeMdPath,
	getManagedClaudeRulesDir,
	getUserClaudeMdPath,
	getUserClaudeRulesDir,
	readExtraGuidelines,
} from "./paths.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryFileType = "Managed" | "User" | "Project" | "Local" | "AutoMem";

export type MemoryFileInfo = {
	path: string;
	type: MemoryFileType;
	content: string;
};

const MEMORY_INSTRUCTION_PROMPT =
	"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

// ============================================================================
// Frontmatter parsing (regex-only — no YAML lib)
// ============================================================================

/**
 * Parse a leading `--- ... ---` frontmatter block into a flat record.
 * Accepts top-level scalar values only (string after `key: `). Arrays and
 * nested objects are not supported because nothing in claude-md's loader
 * actually consumes them.
 *
 * Returns frontmatter = {} when no leading block is present, allowing
 * graceful handling of legacy files.
 */
export function parseFrontmatter(rawContent: string): {
	frontmatter: Record<string, string>;
	content: string;
} {
	const m = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { frontmatter: {}, content: rawContent };

	const frontmatter: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim();
		// Strip surrounding quotes from value, if any.
		let value = trimmed.slice(colonIdx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) frontmatter[key] = value;
	}
	return { frontmatter, content: m[2] };
}

// ============================================================================
// File reading
// ============================================================================

const TEXT_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt",
	"",
]);

function isTextFile(filePath: string): boolean {
	const ext = filePath.toLowerCase().match(/\.[^./\\]+$/);
	if (!ext) return true;
	return TEXT_EXTENSIONS.has(ext[0]);
}

/**
 * Read a memory file and emit content + metadata. Returns null on ENOENT
 * or EISDIR. Symlinks are skipped (defence against @include-style graph
 * loops in Claude Code; we keep parity even though we don't process
 * @include, since CLAUDE.md files are sometimes symlinked for organization).
 */
function readMemoryFile(
	filePath: string,
): { path: string; content: string } | null {
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) return null;
	} catch {
		return null;
	}
	if (!existsSync(filePath)) return null;
	if (!isTextFile(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf-8");
		return { path: filePath, content: raw.trim() };
	} catch {
		return null;
	}
}

// ============================================================================
// Directory walking
// ============================================================================

/**
 * Yield directories from cwd upward to (but not including) the filesystem
 * root. The walk reflects how Claude Code builds its layered CLAUDE.md
 * set — the further up you go, the lower the priority, so directories are
 * yielded parent → child (so the closest one is processed last and sits
 * latest in the prompt).
 */
export function* walkUp(cwd: string): Generator<string> {
	let current = cwd;
	const root = parse(cwd).root;
	while (current !== root) {
		yield current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

/**
 * Recursively scan a rules directory for .md files. Symlinks are skipped.
 */
function scanRulesDir(
	rulesDir: string,
	type: MemoryFileType,
	processedPaths: Set<string>,
): MemoryFileInfo[] {
	const results: MemoryFileInfo[] = [];
	if (!existsSync(rulesDir)) return results;

	let entries: Array<import("node:fs").Dirent>;
	try {
		entries = readdirSync(rulesDir, { withFileTypes: true }) as Array<import("node:fs").Dirent>;
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(rulesDir, entry.name);
		if (processedPaths.has(fullPath)) continue;

		try {
			if (entry.isDirectory()) {
				results.push(...scanRulesDir(fullPath, type, processedPaths));
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const info = readMemoryFile(fullPath);
				if (info && info.content) {
					processedPaths.add(fullPath);
					results.push({ ...info, type });
				}
			}
		} catch {
			// skip unreadable entries
		}
	}
	return results;
}

// ============================================================================
// getMemoryFiles — the main entry point used by index.ts
// ============================================================================

/**
 * Discover all memory files for a given cwd, in priority order (Managed
 * first / lowest-priority, AutoMem last / highest-priority).
 *
 * When `onlyAutoMem` is true, layers 1–4 (Managed / User / Project / Local)
 * are skipped and only the AutoMem entrypoint is returned. pi core already
 * injects the same CLAUDE.md/AGENTS.md layers natively at startup (see
 * `docs/usage.md` and `docs/quickstart.md` in `@earendil-works/pi-coding-agent`),
 * so re-injecting them via this extension caused them to appear twice in
 * the system prompt. The `before_agent_start` injection path passes
 * `onlyAutoMem: true`; the `/memory` picker and `session_start` notify use
 * `getLoadedMemoryFiles()` (no flag) so the file picker still lists every
 * layer.
 */
export function getMemoryFiles(cwd: string, onlyAutoMem?: boolean): MemoryFileInfo[] {
	const results: MemoryFileInfo[] = [];
	const processed = new Set<string>();

	if (onlyAutoMem) {
		// Skip layers 1–4 — pi core already injects those natively. Only
		// load the AutoMem entrypoint (layer 5), which is unique to this
		// extension. Mirrors the AutoMem branch of the 5-layer scan below.
		const autoMemEntry = getAutoMemEntrypoint(cwd);
		if (!processed.has(autoMemEntry) && existsSync(autoMemEntry)) {
			try {
				const raw = readFileSync(autoMemEntry, "utf-8");
				const { content } = truncateEntrypointContent(raw);
				if (content) {
					processed.add(autoMemEntry);
					results.push({ path: autoMemEntry, type: "AutoMem", content });
				}
			} catch {
				// skip
			}
		}
		return results;
	}

	// 1. Managed
	const managedPath = getManagedClaudeMdPath();
	if (managedPath) {
		const info = readMemoryFile(managedPath);
		if (info && info.content) {
			processed.add(managedPath);
			results.push({ ...info, type: "Managed" });
		}
	}
	const managedRulesDir = getManagedClaudeRulesDir();
	if (managedRulesDir) {
		results.push(...scanRulesDir(managedRulesDir, "Managed", processed));
	}

	// 2. User
	const userPath = getUserClaudeMdPath();
	if (!processed.has(userPath)) {
		const info = readMemoryFile(userPath);
		if (info && info.content) {
			processed.add(userPath);
			results.push({ ...info, type: "User" });
		}
	}
	const userRulesDir = getUserClaudeRulesDir();
	results.push(...scanRulesDir(userRulesDir, "User", processed));

	// 3. Project — walk from cwd upward; process from root downward so the
	// closest file ends up latest in the array (highest priority). We
	// collect first then reverse.
	const projectFiles: MemoryFileInfo[] = [];
	for (const dir of walkUp(cwd)) {
		const candidates = [
			join(dir, "CLAUDE.md"),
			join(dir, ".claude", "CLAUDE.md"),
		];
		for (const p of candidates) {
			if (processed.has(p)) continue;
			const info = readMemoryFile(p);
			if (info && info.content) {
				processed.add(p);
				projectFiles.push({ ...info, type: "Project" });
			}
		}
		const rulesDir = join(dir, ".claude", "rules");
		projectFiles.push(...scanRulesDir(rulesDir, "Project", processed));
	}
	// Closer directories override parent — but in our context-ordering,
	// closer directories come LAST (highest priority). walkUp yields them
	// first, so reverse.
	results.push(...projectFiles.reverse());

	// 4. Local — same walk-up pattern, but only CLAUDE.local.md
	const localFiles: MemoryFileInfo[] = [];
	for (const dir of walkUp(cwd)) {
		const p = join(dir, "CLAUDE.local.md");
		if (processed.has(p)) continue;
		const info = readMemoryFile(p);
		if (info && info.content) {
			processed.add(p);
			localFiles.push({ ...info, type: "Local" });
		}
	}
	results.push(...localFiles.reverse());

	// 5. AutoMem entrypoint — truncated if oversized
	const autoMemEntry = getAutoMemEntrypoint(cwd);
	if (!processed.has(autoMemEntry) && existsSync(autoMemEntry)) {
		try {
			const raw = readFileSync(autoMemEntry, "utf-8");
			const { content } = truncateEntrypointContent(raw);
			if (content) {
				processed.add(autoMemEntry);
				results.push({ path: autoMemEntry, type: "AutoMem", content });
			}
		} catch {
			// skip
		}
	}

	return results;
}

// ============================================================================
// Prompt construction
// ============================================================================

function typeDescription(type: MemoryFileType): string {
	switch (type) {
		case "Project":
			return " (project instructions, checked into the codebase)";
		case "Local":
			return " (user's private project instructions, not checked in)";
		case "AutoMem":
			return " (user's auto-memory, persists across conversations)";
		default:
			return " (user's private global instructions for all projects)";
	}
}

/**
 * The behavioral instructions block for AutoMem. Combines the four-type
 * taxonomy with what NOT to save, how to save (two-step), when to access,
 * the before-recommending trust section, the memory-vs-other-persistence
 * section, an optional extraGuidelines slot (Cowork-style), and the
 * searching-past-context section.
 *
 * Source of truth: claude-code/memdir/memdir.ts buildMemoryLines(). Section
 * order is load-bearing — picc uses the same order so the model sees the
 * rules in the same shape it was trained on.
 */
function buildAutoMemInstructions(
	autoMemDir: string,
	projectDir: string,
	extraGuidelines?: string[],
	skipSearch = false,
): string[] {
	return [
		`# ${AUTO_MEM_DISPLAY_NAME}`,
		"",
		`You have a persistent, file-based memory system at \`${autoMemDir}\`. ${DIR_EXISTS_GUIDANCE}`,
		"",
		"You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
		"",
		"If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
		"",
		...TYPES_SECTION_INDIVIDUAL,
		...WHAT_NOT_TO_SAVE_SECTION,
		"",
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
		`- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
		"- Keep the name, description, and type fields in memory files up-to-date with the content",
		"- Organize memory semantically by topic, not chronologically",
		"- Update or remove memories that turn out to be wrong or outdated",
		"- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
		"",
		...WHEN_TO_ACCESS_SECTION,
		"",
		...TRUSTING_RECALL_SECTION,
		"",
		// CC: `## Memory and other forms of persistence` — the single most
		// important behavioral distinction in the memory prompt. picc
		// previously omitted this entirely.
		"## Memory and other forms of persistence",
		"Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
		"- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
		"- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
		...(extraGuidelines ?? []),
		"",
		...buildSearchingPastContextSection(autoMemDir, projectDir, skipSearch),
	];
}

/**
 * "## Searching past context" block — Grep-flavored hint for the model on how
 * to query its own memory files. Source of truth: claude-code/memdir/memdir.ts
 * buildSearchingPastContextSection(), minus the GrowthBook feature gate
 * (picc unconditionally emits this — see plan §Phase 1.5 decision).
 *
 * `projectDir` drives the transcript-log line, which points at the session
 * transcript location on disk.
 */
function buildSearchingPastContextSection(
	autoMemDir: string,
	projectDir: string,
	skipSearch: boolean,
): string[] {
	if (skipSearch) return [];
	const memSearch =
		`Grep with pattern="<search term>" path="${autoMemDir}" glob="*.md"`;
	const transcriptSearch =
		`Grep with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`;
	return [
		"## Searching past context",
		"",
		"When looking for past context:",
		"1. Search topic files in your memory directory:",
		"```",
		memSearch,
		"```",
		"2. Session transcript logs (last resort — large files, slow):",
		"```",
		transcriptSearch,
		"```",
		"Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
		"",
	];
}

/**
 * Build the full memory block for injection into the system prompt.
 * Returns null if no memory files at all (so the host can short-circuit
 * and skip injection entirely).
 *
 * Idempotent: AutoMem directory is created on demand. The system prompt
 * tells the LLM it already exists so it does not waste a turn on mkdir.
 *
 * When `onlyAutoMem` is true, layers 1–4 are skipped so the injection
 * only carries the AutoMem layer (CLAUDE.md content is already injected
 * by pi core natively). The `before_agent_start` path passes
 * `onlyAutoMem: true`; the `/memory` picker uses `getLoadedMemoryFiles()`
 * (no flag) and sees the full set.
 */
export function getMemoryPrompt(cwd: string, onlyAutoMem?: boolean): string | null {
	const files = getMemoryFiles(cwd, onlyAutoMem);

	// The AutoMem behavioral instructions are ALWAYS injected on the
	// before_agent_start path (onlyAutoMem === true) — even when no memory
	// files exist yet — so the LLM learns how/when to save from the very
	// first conversation and creates MEMORY.md itself. Without this, a
	// fresh project would return null below and the extension would stay
	// inert forever (the LLM is never told to create the file). In the
	// non-onlyAutoMem path (picker/extractor consumers) keep the legacy
	// behavior: only include instructions when an AutoMem entry was
	// actually loaded.
	const includeInstructions =
		onlyAutoMem === true || files.some(f => f.type === "AutoMem");

	// Nothing at all to say: no files and no instructions to inject.
	if (files.length === 0 && !includeInstructions) return null;

	const blocks: string[] = [];

	// Lead-in + file content only make sense when there is actual file
	// content below them.
	if (files.length > 0) {
		blocks.push(MEMORY_INSTRUCTION_PROMPT, "");
		for (const file of files) {
			const desc = typeDescription(file.type);
			blocks.push(`Contents of ${file.path}${desc}:\n\n${file.content}`);
		}
	}

	// Append the AutoMem behavioral instructions (after file contents when
	// present, so the LLM has the actual content first, then the
	// how-to-save guidance).
	if (includeInstructions) {
		// Idempotent: ensureMemoryDirExists creates the full chain if
		// missing. System prompt tells the LLM the directory exists.
		const autoMemDir = getAutoMemPath(cwd);
		ensureMemoryDirExists(cwd);
		blocks.push(...buildAutoMemInstructions(autoMemDir, cwd, readExtraGuidelines()));
	}

	return blocks.join("\n");
}

/**
 * Convenience helper for the /memory command: returns the discovered
 * MemoryFileInfo array (caller renders the picker).
 */
export function getLoadedMemoryFiles(cwd: string): MemoryFileInfo[] {
	return getMemoryFiles(cwd);
}
