/**
 * /memory slash command UI.
 *
 * Adapted from claude-code/commands/memory/memory.tsx. Differences:
 *   - pi uses `ctx.ui.select()` instead of a custom JSX dialog.
 *   - We spawn `$VISUAL` / `$EDITOR` / `vim` via child_process (pi doesn't
 *     surface its own `editor()` helper).
 *   - "Create new memory file" is a separate row in the picker; on select,
 *     we prompt for a filename with `ctx.ui.input()` and write a fresh
 *     frontmatter template.
 *
 * Three modes:
 *   - TUI (preferred):  `ctx.ui.select` → editor spawn
 *   - Non-UI (RPC, -p): print file list to `ctx.ui.notify`
 *   - Cancel: pick "" → notify cancellation, return
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getLoadedMemoryFiles, type MemoryFileInfo } from "./claudemd.js";
import { ensureMemoryDirExists, getAutoMemPath } from "./memdir.js";
import { MEMORY_FRONTMATTER_EXAMPLE } from "./memoryTypes.js";

// ============================================================================
// Picker types
// ============================================================================

interface PickerRow {
	label: string;
	description?: string;
	value: string;          // file path or special action key
	action?: "open" | "create";
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Render the file picker and open the selected file in $EDITOR. Called
 * from `registerCommand("memory")` in index.ts.
 */
export async function showMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	const cwd = ctx.cwd;
	const files = await getLoadedMemoryFiles(cwd);
	const rows = buildPickerRows(files, cwd);

	if (!ctx.hasUI) {
		// RPC / -p modes don't support select() — fall back to notify.
		renderNonUi(ctx, files, cwd);
		return;
	}

	if (rows.length === 0) {
		ctx.ui.notify(
			"No memory files found yet. Pick \"Create new memory file\" to add one.",
			"info",
		);
		// Fall through to just-in-time create.
		await runCreate(ctx, cwd, "memory.md");
		return;
	}

	const labelToRow = new Map<string, PickerRow>();
	for (const row of rows) labelToRow.set(row.label, row);

	const labels = rows.map(r => r.label);
	const selected = await ctx.ui.select("Select a memory file to edit", labels);
	if (!selected) {
		ctx.ui.notify("Memory command cancelled.", "info");
		return;
	}

	const row = labelToRow.get(selected);
	if (!row) {
		ctx.ui.notify("Selection no longer valid.", "warning");
		return;
	}

	if (row.action === "create") {
		await runCreate(ctx, cwd, "memory.md");
		return;
	}

	await openInEditor(row.value, ctx);
}

// ============================================================================
// Picker construction
// ============================================================================

function buildPickerRows(files: MemoryFileInfo[], cwd: string): PickerRow[] {
	const rows: PickerRow[] = [];

	for (const file of files) {
		const name = file.path.split(/[/\\]/).pop() ?? file.path;
		const typeLabel = typeDisplay(file.type);
		rows.push({
			label: `${name}  ${typeLabel}`,
			description: file.path,
			value: file.path,
			action: "open",
		});
	}

	// Always offer a "create new" row.
	const autoMemDir = getAutoMemPath(cwd);
	rows.push({
		label: "+ Create new memory file in auto memory",
		description: autoMemDir,
		value: autoMemDir,
		action: "create",
	});

	return rows;
}

function typeDisplay(type: MemoryFileInfo["type"]): string {
	switch (type) {
		case "Managed":
			return "(managed)";
		case "User":
			return "(user)";
		case "Project":
			return "(project)";
		case "Local":
			return "(local)";
		case "AutoMem":
			return "(auto memory)";
	}
}

function renderNonUi(
	ctx: ExtensionCommandContext,
	files: MemoryFileInfo[],
	cwd: string,
): void {
	const lines = ["Memory files:"];
	if (files.length === 0) {
		lines.push("  (none — pick \"+ Create new memory file\" in TUI mode to add one)");
	} else {
		for (const file of files) {
			const name = file.path.split(/[/\\]/).pop() ?? file.path;
			lines.push(`  [${file.type.toLowerCase()}] ${file.path}`);
		}
	}
	lines.push("");
	lines.push(`Auto-memory dir: ${getAutoMemPath(cwd)}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ============================================================================
// Create flow
// ============================================================================

async function runCreate(ctx: ExtensionCommandContext, cwd: string, defaultName: string): Promise<void> {
	const autoMemDir = getAutoMemPath(cwd);
	ensureMemoryDirExists(cwd);

	if (!ctx.hasUI) {
		// Already communicated the path via renderNonUi — nothing more to do.
		return;
	}

	const name = await ctx.ui.input("New memory file name (relative to auto-memory dir):", defaultName);
	if (!name) {
		ctx.ui.notify("Create cancelled.", "info");
		return;
	}

	const safeName = sanitizeMemoryName(name);
	const fullPath = join(autoMemDir, safeName);

	if (existsSync(fullPath)) {
		ctx.ui.notify(`File already exists: ${fullPath} — opening for edit.`, "info");
	} else {
		writeFileSync(fullPath, freshMemoryTemplate(safeName), "utf-8");
		ctx.ui.notify(`Created ${fullPath}`, "info");
	}

	await openInEditor(fullPath, ctx);
}

function sanitizeMemoryName(name: string): string {
	let n = name.trim();
	if (!n.endsWith(".md")) n += ".md";
	// Block path separators outright — the user would otherwise be able to
	// escape the auto-memory directory.
	n = n.replace(/[/\\]/g, "_");
	// Disallow leading dots (hidden files) and the reserved entrypoint name.
	const base = n.split("/").pop() ?? n;
	if (base.startsWith(".")) n = "_" + n;
	if (n === "MEMORY.md") n = "MEMORY.extra.md";
	return n;
}

function freshMemoryTemplate(filename: string): string {
	const stem = filename.replace(/\.md$/, "");
	const title = stem.replace(/[_-]+/g, " ").trim();
	const lines: string[] = [
		"---",
		`name: ${title || "memory"}`,
		"description: one-line description — used to decide relevance in future conversations",
		"type: user   # one of: user, feedback, project, reference",
		"---",
		"",
		"Write the memory here. For feedback/project types, structure the body as:",
		"  Lead with the rule or fact.",
		"  **Why:** the reason behind it (incident, preference, constraint).",
		"  **How to apply:** when/where this guidance kicks in.",
		"",
		"# (delete this scaffold and replace)",
	];
	return lines.join("\n");
}

// Keep the import referenced — used by runCreate for context.
const _FMT = MEMORY_FRONTMATTER_EXAMPLE; // eslint-disable-line @typescript-eslint/no-unused-vars

// ============================================================================
// Editor launch
// ============================================================================

async function openInEditor(filePath: string, ctx: ExtensionCommandContext): Promise<void> {
	const editor = resolveEditor();
	if (!editor) {
		ctx.ui.notify(
			`No $VISUAL / $EDITOR / vim found. File located at: ${filePath}`,
			"warning",
		);
		return;
	}

	// Make sure the parent directory exists (mkdir -p pattern) so an
	// already-created file path is always writable.
	try {
		mkdirSync(dirname(filePath), { recursive: true });
	} catch {
		// ignore — open will surface a real error if the path is unusable
	}

	await new Promise<void>(resolve => {
		try {
			const child = spawn(editor, [filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
				cwd: ctx.cwd,
			});
			child.on("exit", code => {
				if (code === 0 || code === null) {
					ctx.ui.notify(`Saved ${filePath}`, "info");
				} else {
					ctx.ui.notify(`Editor exited with code ${code}`, "warning");
				}
				resolve();
			});
			child.on("error", err => {
				ctx.ui.notify(`Failed to open editor (${editor}): ${err.message}`, "error");
				resolve();
			});
		} catch (err) {
			ctx.ui.notify(`Failed to launch ${editor}: ${(err as Error).message}`, "error");
			resolve();
		}
	});
}

function resolveEditor(): string | undefined {
	const visual = process.env.VISUAL?.trim();
	if (visual) return visual;
	const terminal = process.env.EDITOR?.trim();
	if (terminal) return terminal;
	// Sensible fallback chain.
	for (const candidate of ["vim", "vi", "nano", "notepad.exe"]) {
		try {
			// Naive presence check — `which` is fine on Unix but unreliable
			// on Windows. Test by spawn: a synchronous "sh -c command -v"
			// would be more correct, but we keep it simple.
			if (candidate === "notepad.exe" && process.platform === "win32") return candidate;
		} catch {
			// ignore
		}
	}
	// Last resort: just `vim` (most likely present if the user has any
	// terminal chops; the spawn error path surfaces a clear message).
	return "vim";
}
