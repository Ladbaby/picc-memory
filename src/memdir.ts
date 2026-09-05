import { existsSync, mkdirSync } from "node:fs";
import { getAutoMemPath } from "./paths.js";
export const ENTRYPOINT_NAME = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
const AUTO_MEM_DISPLAY_NAME = "auto memory";
export const DIR_EXISTS_GUIDANCE =
	"This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).";
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
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
	const trimmed = raw.trim();
	const contentLines = trimmed.split(/\r?\n/);
	const lineCount = contentLines.length;
	const byteCount = trimmed.length;
	const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
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
export function ensureMemoryDirExists(cwd: string): void {
	const dir = getAutoMemPath(cwd);
	if (existsSync(dir)) return;
	try {
		mkdirSync(dir, { recursive: true });
	} catch (e) {
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
export { AUTO_MEM_DISPLAY_NAME };
export { getAutoMemPath, getAutoMemEntrypoint, isAutoMemPath } from "./paths.js";
