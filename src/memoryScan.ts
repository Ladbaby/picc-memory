import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./claudemd.js";
import { parseMemoryType, type MemoryType } from "./memoryTypes.js";
const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;
export type MemoryHeader = {
	filename: string;
	filePath: string;
	mtimeMs: number;
	description: string | null;
	type: MemoryType | undefined;
};
function collectMemoryFiles(memoryDir: string): Array<{
	relativePath: string;
	fullPath: string;
	mtimeMs: number;
}> {
	const out: Array<{ relativePath: string; fullPath: string; mtimeMs: number }> = [];
	function walk(dir: string, base: string): void {
		let entries: Array<import("node:fs").Dirent>;
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as Array<import("node:fs").Dirent>;
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			const rel = join(base, entry.name);
			try {
				if (entry.isDirectory()) {
					walk(full, rel);
				} else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md") {
					const stat = statSync(full);
					out.push({ relativePath: rel, fullPath: full, mtimeMs: stat.mtimeMs });
				}
			} catch {
			}
		}
	}
	walk(memoryDir, "");
	return out;
}
export function scanMemoryFiles(memoryDir: string): MemoryHeader[] {
	try {
		if (!existsSync(memoryDir)) return [];
		const files = collectMemoryFiles(memoryDir);
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const headers: MemoryHeader[] = [];
		for (const f of files.slice(0, MAX_MEMORY_FILES)) {
			try {
				const raw = readFileSync(f.fullPath, "utf-8");
				const head = raw.split(/\r?\n/).slice(0, FRONTMATTER_MAX_LINES).join("\n");
				const { frontmatter } = parseFrontmatter(head);
				headers.push({
					filename: f.relativePath,
					filePath: f.fullPath,
					mtimeMs: f.mtimeMs,
					description: frontmatter.description || null,
					type: parseMemoryType(frontmatter.type),
				});
			} catch {
			}
		}
		return headers;
	} catch {
		return [];
	}
}
export function formatMemoryManifest(headers: MemoryHeader[]): string {
	if (headers.length === 0) return "(no memory files yet)";
	return headers
		.map(h => {
			const tag = h.type ? `[${h.type}] ` : "";
			const ts = new Date(h.mtimeMs).toISOString();
			const desc = h.description ? `: ${h.description}` : "";
			const portable = h.filename.split(/[/\\]/).join("/");
			return `- ${tag}${portable} (${ts})${desc}`;
		})
		.join("\n");
}
export function describeFilePath(filePath: string): string {
	const name = basename(filePath);
	if (name === "CLAUDE.md") {
		if (filePath.includes(".claude")) return "Project (.claude/CLAUDE.md)";
		return "Project (CLAUDE.md)";
	}
	if (name === "CLAUDE.local.md") return "Local (CLAUDE.local.md)";
	if (name === "MEMORY.md") return "Auto memory (MEMORY.md)";
	return `Rule (${name})`;
}
