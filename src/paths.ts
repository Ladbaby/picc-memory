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
 *   memoryBase    = ~/.claude/                  (overridable in Claude Code; v1 fixed here)
 *   autoMemDir    = <memoryBase>/projects/<sanitized-git-root>/memory/
 *   autoMemEntry  = <autoMemDir>/MEMORY.md
 *   managedClaude = /etc/claude-code/CLAUDE.md         (Unix)
 *                   C:\ProgramData\claude-code\CLAUDE.md (Windows)
 *   userClaude    = <memoryBase>/CLAUDE.md
 *   userRulesDir  = <memoryBase>/rules/
 */

import { execSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

// ============================================================================
// Constants
// ============================================================================

const AUTO_MEM_DIRNAME = "memory";
const AUTO_MEM_ENTRYPOINT_NAME = "MEMORY.md";

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
export function getMemoryBaseDir(): string {
	return join(homedir(), ".claude") + sep;
}

// ============================================================================
// Auto-memory directory path (the "personal" memory store)
// ============================================================================

function sanitizePath(rawPath: string): string {
	// Replace path separators and reserved chars with underscores, then
	// collapse runs. Matches sanitizePath in claude-code/utils/path.ts
	// behaviour closely enough to be a stable directory name.
	return rawPath
		.replace(/[/\\:]/g, "_")
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
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
export function validateMemoryPath(raw: string | undefined, _expandTilde = false): string | undefined {
	if (!raw) return undefined;
	const candidate = raw;
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

/**
 * Returns the auto-memory directory path: <memoryBase>/projects/<sanitized>/memory/.
 *
 * Memoized on `cwd` — render-path callers (e.g. isAutoMemPath inside tool
 * filtering) fire per tool-use message, and each miss would otherwise
 * re-run git rev-parse. Closes over cwd so tests can clear by changing cwd.
 *
 * Source of truth: claude-code/memdir/paths.ts getAutoMemPath(). The
 * `.normalize('NFC')` matches CC's Unicode canonicalization.
 */
const autoMemPathCache = new Map<string, string>();

export function getAutoMemPath(cwd: string): string {
	const cached = autoMemPathCache.get(cwd);
	if (cached !== undefined) return cached;
	const memoryBase = getMemoryBaseDir();
	const projectsDir = join(memoryBase, "projects");
	const sanitized = sanitizePath(getAutoMemBase(cwd));
	const result = (normalize(join(projectsDir, sanitized, AUTO_MEM_DIRNAME)) + sep).normalize("NFC");
	autoMemPathCache.set(cwd, result);
	return result;
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
	return join(getMemoryBaseDir(), "CLAUDE.md");
}

function getUserClaudeRulesDir(): string {
	return join(getMemoryBaseDir(), "rules");
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
