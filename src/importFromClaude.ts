/**
 * One-time import of a project's memory from Claude Code into picc's memory
 * directory.
 *
 * picc-memory now stores per-project memory under the extension install dir
 * (~/.pi/agent/extensions/picc-memory/projects/<sanitized>/memory/) instead of
 * Claude Code's ~/.claude/projects/... — so users who previously used Claude
 * Code lose access to their saved memories unless we copy them over. This
 * module performs that migration lazily and idempotently: the very first
 * session in a project whose picc memory dir is still empty copies the whole
 * per-project memory folder from Claude Code's corresponding location (see
 * paths.getClaudeMemorySourceDir). Once the destination holds any file the
 * import is a no-op for the rest of the project's life.
 *
 * All path resolution (including locating the Claude Code source dir) lives in
 * ./paths.ts; this file only handles the filesystem copy.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getClaudeMemorySourceDir } from "./paths.js";

/**
 * True when `dir` exists and contains at least one regular file.
 */
function dirHasFiles(dir: string): boolean {
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile()) return true;
		}
	} catch {
		// missing / unreadable dir → treat as empty
	}
	return false;
}

/**
 * Recursively copy every regular file under `srcDir` into `destDir`,
 * preserving relative subpaths (e.g. `logs/2026/03/foo.md`). Existing files
 * in `destDir` are skipped, so a re-run only fills gaps. Returns the number
 * of files actually copied.
 */
function copyDirRecursive(srcDir: string, destDir: string): number {
	let count = 0;
	try {
		for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
			const srcPath = join(srcDir, entry.name);
			const destPath = join(destDir, entry.name);
			try {
				if (entry.isDirectory()) {
					count += copyDirRecursive(srcPath, destPath);
				} else if (entry.isFile()) {
					if (!existsSync(destPath)) {
						mkdirSync(dirname(destPath), { recursive: true });
						copyFileSync(srcPath, destPath);
						count++;
					}
				}
				// symlinks / fifos etc. are skipped on purpose
			} catch {
				// skip unreadable entries; keep going
			}
		}
	} catch {
		// source dir vanished mid-copy; return what we managed to copy
	}
	return count;
}

/**
 * Copy the current project's memory from Claude Code into picc's destination
 * memory dir — but only if the destination is still empty.
 *
 * Returns the number of files copied (0 when nothing was needed / available).
 * Safe to call on every agent turn: the "destination has files" check is a
 * cheap readdir and short-circuits once the migration has happened once.
 */
export function autoImportMemoryIfEmpty(destDir: string, cwd: string): number {
	const sourceDir = getClaudeMemorySourceDir(cwd);
	// If source and destination are the same location there is nothing to do.
	if (sourceDir === destDir) return 0;
	// Never overwrite an already-populated destination.
	if (dirHasFiles(destDir)) return 0;
	// Nothing to import if Claude Code has no memory for this project yet.
	if (!existsSync(sourceDir) || !dirHasFiles(sourceDir)) return 0;
	mkdirSync(destDir, { recursive: true });
	return copyDirRecursive(sourceDir, destDir);
}

// Re-exported so callers can render the source path in notifications without
// re-deriving it.
export { getClaudeMemorySourceDir };
