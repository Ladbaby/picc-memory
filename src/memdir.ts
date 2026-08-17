/**
 * Auto-memory directory management + MEMORY.md truncation.
 *
 * Adapted from claude-code/memdir/memdir.ts lines 24-93 (truncation) and
 * ensureMemoryDirExists. The behavioral prompt builder lives in
 * claudemd.ts (buildAutoMemInstructions) so that this file stays as thin
 * as its Claude Code counterpart.
 */

import { existsSync, mkdirSync } from "node:fs";
import { getAutoMemPath } from "./paths.js";

// ============================================================================
// Constants — match Claude Code exactly
// ============================================================================

export const ENTRYPOINT_NAME = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000;

const AUTO_MEM_DISPLAY_NAME = "auto memory";

/**
 * Shared guidance text for "directory already exists" calls. Shipped because
 * Claude was burning turns on `ls`/`mkdir -p` before writing. The harness
 * guarantees the directory exists via ensureMemoryDirExists().
 *
 * Source of truth: claude-code/memdir/memdir.ts DIR_EXISTS_GUIDANCE.
 */
export const DIR_EXISTS_GUIDANCE =
	"This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).";

/**
 * Format a byte count as a human-readable string. Mirrors the inline behavior
 * of claude-code/utils/format.formatFileSize() for the units we use (KB / MB
 * rounded to one / two decimals respectively).
 *
 * Source of truth: claude-code/utils/format.js — reimplemented locally to
 * avoid pulling in the full utils layer for one call site.
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export type EntrypointTruncation = {
	content: string;
	lineCount: number;
	byteCount: number;
	wasLineTruncated: boolean;
	wasByteTruncated: boolean;
};

// ============================================================================
// Truncation
// ============================================================================

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 *
 * Shared by buildMemoryPrompt and claudemd getMemoryFiles.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
	const trimmed = raw.trim();
	const contentLines = trimmed.split(/\r?\n/);
	const lineCount = contentLines.length;
	const byteCount = trimmed.length;

	const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
	// Check original byte count — long lines are the failure mode the byte cap
	// targets, so post-line-truncation size would understate the warning.
	const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

	if (!wasLineTruncated && !wasByteTruncated) {
		return {
			content: trimmed,
			lineCount,
			byteCount,
			wasLineTruncated,
			wasByteTruncated,
		};
	}

	let truncated = wasLineTruncated
		? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
		: trimmed;

	if (truncated.length > MAX_ENTRYPOINT_BYTES) {
		const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
		truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
	}

	const reason =
		wasByteTruncated && !wasLineTruncated
			? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
			: wasLineTruncated && !wasByteTruncated
				? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
				: `${lineCount} lines and ${formatFileSize(byteCount)}`;

	return {
		content:
			truncated +
			`\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
		lineCount,
		byteCount,
		wasLineTruncated,
		wasByteTruncated,
	};
}

// ============================================================================
// Directory creation
// ============================================================================

/**
 * Ensure the auto-memory directory exists. Idempotent. mkdirSync with
 * recursive: true swallows EEXIST, so the full parent chain
 * (~/.claude/projects/<slug>/memory/) is created in one call with no
 * try/catch needed for the happy path.
 *
 * Permission errors are propagated so the model's Write tool surfaces
 * the real failure.
 */
export function ensureMemoryDirExists(cwd: string): void {
	const dir = getAutoMemPath(cwd);
	if (existsSync(dir)) return;
	try {
		mkdirSync(dir, { recursive: true });
	} catch (e) {
		// ENOTDIR/ENAMETOOLONG/EEXIST-on-non-dir are real but recoverable
		// errors — the Write tool will surface them. Surface everything else.
		const code =
			e instanceof Error && "code" in e && typeof e.code === "string"
				? e.code
				: undefined;
		if (code !== "EEXIST" && code !== "ENOTDIR") {
			console.error(
				`[picc-memory] ensureMemoryDirExists failed for ${dir}: ${code ?? String(e)}`,
			);
		}
	}
}

// Re-export display name for use by claudemd prompt builder.
export { AUTO_MEM_DISPLAY_NAME };

// Re-export path helpers so callers (extractor, memoryCommand) don't need
// to also import paths.ts.
export { getAutoMemPath, getAutoMemEntrypoint, isAutoMemPath } from "./paths.js";
