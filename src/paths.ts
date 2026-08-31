/**
 * Memory path resolution.
 *
 * Adapted from claude-code/memdir/paths.ts with the following simplifications:
 *   - No CLAUDE_CODE_REMOTE_MEMORY_DIR / CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
 *     env-var chain (CCR / Cowork-specific).
 *   - No settings.json autoMemoryDirectory override (project setting would
 *     be a trust-amplification surface we don't need).
 *   - Validates paths for absolute, length, drive-root, UNC, null-byte
 *     hazards — same security checks as Claude Code.
 *
 * Path summary:
 *   memoryBase    = <agentDir>/extensions/picc-memory/   (≈ ~/.pi/agent/extensions/picc-memory/)
 *   autoMemDir    = resolved per the chain in getAutoMemPath():
 *                     1. PICC_REMOTE_MEMORY_DIR            (base dir)
 *                     2. picc config.json autoMemoryDirectory (full dir)
 *                     3. CLAUDE_CODE_REMOTE_MEMORY_DIR     (base dir)
 *                     4. claude-code settings.json autoMemoryDirectory (full dir)
 *                     5. <memoryBase>/projects/<sanitized-git-root>/memory/
 *   autoMemEntry  = <autoMemDir>/MEMORY.md
 *   managedClaude = /etc/claude-code/CLAUDE.md         (Unix)
 *                   C:\ProgramData\claude-code\CLAUDE.md (Windows)
 *   userClaude    = <claudeConfigHome>/CLAUDE.md       (≈ ~/.claude/CLAUDE.md)
 *   userRulesDir  = <claudeConfigHome>/rules/
 *
 * The user/managed CLAUDE.md layers live in Claude Code's *config home*
 * (~/.claude), kept distinct from the memory base so relocating memory does
 * not move the CLAUDE.md discovery roots.
 *
 * `sanitizePath` mirrors claude-code byte-for-byte (dash-based, 200-char
 * truncation + djb2 hash) so the project key matches Claude Code's, which is
 * what makes auto-import from Claude Code's memory unambiguous.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

// ============================================================================
// Constants
// ============================================================================

const AUTO_MEM_DIRNAME = "memory";
const AUTO_MEM_ENTRYPOINT_NAME = "MEMORY.md";

/** Max length for a single sanitized path component (matches claude-code). */
const MAX_SANITIZED_LENGTH = 200;

/**
 * Memory-directory base overrides (base dirs — /projects/<sanitized>/memory/
 * is appended). Higher precedence first.
 */
const ENV_PICC_REMOTE_MEMORY_DIR = "PICC_REMOTE_MEMORY_DIR";
const ENV_CC_REMOTE_MEMORY_DIR = "CLAUDE_CODE_REMOTE_MEMORY_DIR";
/**
 * Claude Code's full-path override + config-home var, consulted only when
 * locating Claude Code's *source* memory dir for auto-import (see
 * importFromClaude.ts). Not part of picc's own destination chain.
 */
const ENV_CC_COWORK_OVERRIDE = "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE";
const ENV_CC_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

/** Override for the picc-memory config.json location. */
const ENV_PICC_MEMORY_CONFIG_PATH = "PICC_MEMORY_CONFIG_PATH";

/** Git rev-parse timeout — keeps startup responsive on slow git repos. */
const GIT_ROOT_TIMEOUT_MS = 5_000;

/** Disable AutoMem kill-switches. Order of precedence: */
const ENV_DISABLE_PICC = "PICC_DISABLE_AUTO_MEMORY";
const ENV_DISABLE_CC = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/** Extra guidelines for the AutoMem block. Order of precedence: */
const ENV_EXTRA_PICC = "PICC_MEMORY_EXTRA_GUIDELINES";
const ENV_EXTRA_CC = "CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES";

// ============================================================================
// Env-var helpers (shims for CC's envUtils)
// ============================================================================

/**
 * True if value is one of the strings CC treats as truthy: "1", "true", "yes"
 * (case-insensitive, trimmed).
 */
export function isEnvTruthy(v: string | undefined): boolean {
	return typeof v === "string" && /^(1|true|yes)$/i.test(v.trim());
}

/**
 * True if value is one of the strings CC treats as falsy: "0", "false", "no"
 * (case-insensitive, trimmed). Empty / undefined → false (undefined is
 * "unset", not "defined falsy").
 */
export function isEnvDefinedFalsy(v: string | undefined): boolean {
	return typeof v === "string" && /^(0|false|no)$/i.test(v.trim());
}

/**
 * Read extra-guidelines env vars in priority order. Returns undefined when
 * neither is set so callers can fall through to CC's no-extraGuidelines
 * behavior. Trimmed to defend against trailing-whitespace env writes.
 */
export function readExtraGuidelines(): string[] | undefined {
	const local = process.env[ENV_EXTRA_PICC]?.trim();
	if (local) return [local];
	const cowork = process.env[ENV_EXTRA_CC]?.trim();
	if (cowork) return [cowork];
	return undefined;
}

/**
 * Whether AutoMem (the persistent personal memory system) is enabled.
 *
 * Mirrors claude-code/memdir/paths.ts isAutoMemoryEnabled, minus the
 * CCR/CLAUDE_CODE_SIMPLE/settings.json layers that don't apply to pi.
 *
 * Priority chain (first defined wins):
 *   1. PICC_DISABLE_AUTO_MEMORY truthy → OFF
 *   2. PICC_DISABLE_AUTO_MEMORY falsy  → ON
 *   3. CLAUDE_CODE_DISABLE_AUTO_MEMORY truthy → OFF
 *   4. CLAUDE_CODE_DISABLE_AUTO_MEMORY falsy  → ON
 *   5. Default: ON
 */
export function isAutoMemoryEnabled(): boolean {
	const picc = process.env[ENV_DISABLE_PICC];
	if (isEnvTruthy(picc)) return false;
	if (isEnvDefinedFalsy(picc)) return true;
	const cc = process.env[ENV_DISABLE_CC];
	if (isEnvTruthy(cc)) return false;
	if (isEnvDefinedFalsy(cc)) return true;
	return true;
}

// ============================================================================
// Memory base dir
// ============================================================================

/**
 * The base directory for persistent memory storage.
 * Equivalent to claude-code's getMemoryBaseDir().
 *
 * In Claude Code this can be overridden by CLAUDE_CODE_REMOTE_MEMORY_DIR (CCR).
 * In v1 we keep it pinned to ~/.claude/ so it remains consistent across
 * platforms and shells.
 */
/**
 * The base directory for persistent *memory* storage (the AutoMem root).
 *
 * Defaults to the picc-memory extension install dir
 * (`<agentDir>/extensions/picc-memory/`, ≈ `~/.pi/agent/extensions/picc-memory/`)
 * so per-project memory lives with the extension rather than in Claude
 * Code's `~/.claude`. Overridden per-cwd by the chain in `getAutoMemPath`.
 * `getAgentDir()` respects `$PI_CODING_AGENT_DIR`.
 */
export function getMemoryBaseDir(): string {
	return join(getAgentDir(), "extensions", "picc-memory") + sep;
}

/**
 * Claude Code's *config home* — where user/managed CLAUDE.md and settings
 * live. Kept distinct from the memory base so relocating memory does not move
 * the CLAUDE.md discovery roots or the source location used for auto-import.
 * Mirrors claude-code's getClaudeConfigHomeDir().
 */
export function getClaudeConfigHomeDir(): string {
	return process.env[ENV_CC_CONFIG_DIR] ?? join(homedir(), ".claude");
}

// ============================================================================
// Auto-memory directory path (the "personal" memory store)
// ============================================================================

function djb2Hash(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return h;
}

/**
 * Make a string safe for use as a directory name. Mirrors claude-code's
 * `sanitizePath` (utils/sessionStoragePortable.ts) byte-for-byte: every
 * non-alphanumeric char → `-`, truncated to MAX_SANITIZED_LENGTH with a djb2
 * hash suffix when longer. Matching it exactly is REQUIRED so the per-project
 * directory key equals Claude Code's, which is what makes auto-import from
 * Claude Code's memory unambiguous.
 */
function sanitizePath(rawPath: string): string {
	const sanitized = rawPath.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= MAX_SANITIZED_LENGTH) {
		return sanitized;
	}
	return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(rawPath)).toString(36)}`;
}

/**
 * Normalize and validate a candidate memory directory path. Mirrors
 * `validateMemoryPath` in claude-code/memdir/paths.ts — the security
 * hardening is universal, even though we don't yet expose tilde-expansion
 * or Cowork overrides.
 *
 * SECURITY: rejects paths that would be dangerous as a read-allowlist root
 * or that normalize() doesn't fully resolve:
 *   - relative (!isAbsolute)
 *   - root/near-root (length < 3): "/" → "" after strip; "/a" too short
 *   - Windows drive-root (C: regex): "C:\" → "C:" after strip
 *   - UNC paths (\\server\share) or double-forward-slash (//foo) — opaque
 *     trust boundary
 *   - null byte: survives normalize(), can truncate in syscalls
 *
 * Returns the normalized path with exactly one trailing separator, or
 * undefined if the path is unset/empty/rejected. NFC normalization matches
 * CC (Unicode canonicalization so a path written one way and read another
 * compares equal).
 */
export function validateMemoryPath(raw: string | undefined, expandTilde = false): string | undefined {
	if (!raw) return undefined;
	let candidate = raw;
	// Full-dir settings support `~/` expansion (user-friendly). Bare "~",
	// "~/", "~/.", etc. are NOT expanded — they would make the resolved dir
	// collapse to $HOME or an ancestor (same class of danger as "/").
	// Mirrors claude-code's validateMemoryPath().
	if (expandTilde && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
		const rest = candidate.slice(2);
		const restNorm = normalize(rest || ".");
		if (restNorm === "." || restNorm === "..") {
			return undefined;
		}
		candidate = join(homedir(), rest);
	}
	const normalized = normalize(candidate).replace(/[/\\]+$/, "");
	if (
		!isAbsolute(normalized) ||
		normalized.length < 3 ||
		/^[A-Za-z]:$/.test(normalized) ||
		normalized.startsWith("\\\\") ||
		normalized.startsWith("//") ||
		normalized.includes("\0")
	) {
		return undefined;
	}
	return (normalized + sep).normalize("NFC");
}

function findCanonicalGitRoot(cwd: string): string | null {
	// git rev-parse --show-toplevel returns the worktree root, so all
	// worktrees of the same repo share one auto-memory directory — matches
	// anthropics/claude-code#24382. Falls back to null if not in a repo
	// or git is unavailable.
	try {
		const result = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			timeout: GIT_ROOT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const trimmed = result.trim();
		return trimmed ? normalize(trimmed) : null;
	} catch {
		return null;
	}
}

function getAutoMemBase(cwd: string): string {
	return findCanonicalGitRoot(cwd) ?? normalize(cwd);
}

// ============================================================================
// Settings readers (config.json + claude-code settings.json)
// ============================================================================

type MemoryConfig = { autoMemoryDirectory?: string };

function readJsonConfig(path: string): MemoryConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed && typeof parsed === "object") return parsed as MemoryConfig;
		return {};
	} catch {
		return {};
	}
}

/**
 * Path to picc-memory's own config.json. Env override first, then the
 * extension install dir (Pattern B — sibling to picc-read/grep/etc.; survives
 * reinstalls and is gitignored).
 */
export function getPiccMemoryConfigPath(): string {
	return (
		process.env[ENV_PICC_MEMORY_CONFIG_PATH] ??
		join(getAgentDir(), "extensions", "picc-memory", "config.json")
	);
}

/** picc-memory's own `autoMemoryDirectory` (full dir). */
export function readPiccMemoryConfig(): MemoryConfig {
	return readJsonConfig(getPiccMemoryConfigPath());
}

/**
 * Claude Code's `autoMemoryDirectory` from its user settings.json (full dir).
 * Honors $CLAUDE_CONFIG_DIR. Only the user-level file is consulted — mirrors
 * claude-code skipping projectSettings (a checked-in .claude/settings.json
 * must not be able to redirect memory).
 */
export function readClaudeMemoryConfig(): MemoryConfig {
	const path = join(getClaudeConfigHomeDir(), "settings.json");
	return existsSync(path) ? readJsonConfig(path) : {};
}

/**
 * Resolve where **Claude Code** stores this project's memory, to use as the
 * auto-import source. Replicates claude-code/memdir/paths.ts getAutoMemPath():
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE      (full dir)
 *   2. claude settings.json autoMemoryDirectory (full dir, ~/ expand)
 *   3. <base>/projects/<sanitized-git-root>/memory/  where base is
 *      CLAUDE_CODE_REMOTE_MEMORY_DIR ?? $CLAUDE_CONFIG_DIR ?? ~/.claude
 */
export function getClaudeMemorySourceDir(cwd: string): string {
	const sanitized = sanitizePath(getAutoMemBase(cwd));
	const fromCowork = mapToMemDir(process.env[ENV_CC_COWORK_OVERRIDE], sanitized, true);
	if (fromCowork) return fromCowork;
	const fromSetting = mapToMemDir(readClaudeMemoryConfig().autoMemoryDirectory, sanitized, true);
	if (fromSetting) return fromSetting;
	const base = validateMemoryPath(process.env[ENV_CC_REMOTE_MEMORY_DIR], false) ?? getClaudeConfigHomeDir() + sep;
	return (join(base, "projects", sanitized, AUTO_MEM_DIRNAME) + sep).normalize("NFC");
}

/**
 * Map a raw candidate dir into a concrete auto-memory directory, or undefined
 * if it is unset or fails validation.
 *
 * - `full === false` (base dir, e.g. *_REMOTE_MEMORY_DIR): no tilde expansion,
 *   and `<base>/projects/<sanitized>/memory/` is appended.
 * - `full === true` (settings autoMemoryDirectory): `~/` expansion, used
 *   directly as the memory dir.
 */
function mapToMemDir(raw: string | undefined, sanitized: string, full: boolean): string | undefined {
	const validated = validateMemoryPath(raw, full);
	if (!validated) return undefined;
	if (full) return validated;
	return join(validated, "projects", sanitized, AUTO_MEM_DIRNAME) + sep;
}

// ============================================================================
// Auto-memory directory path (the "personal" memory store)
// ============================================================================

/**
 * Returns the auto-memory directory path.
 *
 * Resolution order (first defined wins):
 *   1. PICC_REMOTE_MEMORY_DIR                 (base dir)
 *   2. picc config.json autoMemoryDirectory   (full dir)
 *   3. CLAUDE_CODE_REMOTE_MEMORY_DIR          (base dir)
 *   4. claude-code settings.json autoMemoryDirectory (full dir)
 *   5. <getMemoryBaseDir()>/projects/<sanitized-git-root>/memory/
 *
 * Memoized on `cwd` — render-path callers (e.g. isAutoMemPath) fire per
 * tool-use message, and each miss would otherwise re-run git rev-parse.
 * Closes over cwd so tests can clear by changing cwd. `.normalize('NFC')`
 * matches claude-code's Unicode canonicalization.
 */
const autoMemPathCache = new Map<string, string>();

export function getAutoMemPath(cwd: string): string {
	const cached = autoMemPathCache.get(cwd);
	if (cached !== undefined) return cached;
	const sanitized = sanitizePath(getAutoMemBase(cwd));
	const result =
		mapToMemDir(process.env[ENV_PICC_REMOTE_MEMORY_DIR], sanitized, false) ??
		mapToMemDir(readPiccMemoryConfig().autoMemoryDirectory, sanitized, true) ??
		mapToMemDir(process.env[ENV_CC_REMOTE_MEMORY_DIR], sanitized, false) ??
		mapToMemDir(readClaudeMemoryConfig().autoMemoryDirectory, sanitized, true) ??
		join(getMemoryBaseDir(), "projects", sanitized, AUTO_MEM_DIRNAME) + sep;
	const normalized = (normalize(result) + sep).normalize("NFC");
	autoMemPathCache.set(cwd, normalized);
	return normalized;
}

/** Returns the path of MEMORY.md inside the auto-memory directory. */
export function getAutoMemEntrypoint(cwd: string): string {
	return join(getAutoMemPath(cwd), AUTO_MEM_ENTRYPOINT_NAME);
}

/**
 * True when absolutePath is within the auto-memory directory. Normalized
 * to defeat `..` traversal bypasses.
 *
 * Pre-validates absolutePath via validateMemoryPath() — same defensive
 * hardening CC applies before this kind of allowlist check.
 */
export function isAutoMemPath(absolutePath: string, cwd: string): boolean {
	try {
		const validated = validateMemoryPath(absolutePath, false);
		const candidate = validated ?? normalize(absolutePath);
		return candidate.startsWith(getAutoMemPath(cwd));
	} catch {
		return false;
	}
}

/** Invalidate the getAutoMemPath memo. Used by session / cwd changes. */
export function clearAutoMemPathCache(): void {
	autoMemPathCache.clear();
}

// ============================================================================
// CLAUDE.md paths (Managed, User)
// ============================================================================

function getManagedClaudeMdPath(): string | undefined {
	if (process.platform === "win32") {
		// claude-code maps /etc/claude-code to %ProgramData% on Windows.
		const winPath = join(
			process.env.ProgramData ?? "C:\\ProgramData",
			"claude-code",
			"CLAUDE.md",
		);
		return existsSync(winPath) ? winPath : undefined;
	}
	const unixPath = "/etc/claude-code/CLAUDE.md";
	return existsSync(unixPath) ? unixPath : undefined;
}

function getManagedClaudeRulesDir(): string | undefined {
	if (process.platform === "win32") {
		const winPath = join(
			process.env.ProgramData ?? "C:\\ProgramData",
			"claude-code",
			"rules",
		);
		return existsSync(winPath) ? winPath : undefined;
	}
	const unixPath = "/etc/claude-code/rules";
	return existsSync(unixPath) ? unixPath : undefined;
}

function getUserClaudeMdPath(): string {
	return join(getClaudeConfigHomeDir(), "CLAUDE.md");
}

function getUserClaudeRulesDir(): string {
	return join(getClaudeConfigHomeDir(), "rules");
}

// ============================================================================
// Symlink safety
// ============================================================================

/**
 * True when path is a symlink. The Claude Code memory walker treats
 * symlinked memory files as untrusted and bypasses their bytes; we apply
 * the same defensive check before reading (caller's responsibility).
 */
export function isSymlink(filePath: string): boolean {
	try {
		return lstatSync(filePath).isSymbolicLink();
	} catch {
		return false;
	}
}

// ============================================================================
// Re-exports
// ============================================================================

export {
	getManagedClaudeMdPath,
	getManagedClaudeRulesDir,
	getUserClaudeMdPath,
	getUserClaudeRulesDir,
	findCanonicalGitRoot,
};

// Surface isAbsolute to avoid an unused import warning while keeping the
// symmetry of Claude Code's validateMemoryPath for future expansion.
export const _isAbsolute = isAbsolute;
