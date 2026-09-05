import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureMemoryDirExists } from "./memdir.js";
import { getMemoryPrompt, getLoadedMemoryFiles } from "./claudemd.js";
import { autoImportMemoryIfEmpty } from "./importFromClaude.js";
import { showMemoryCommand } from "./memoryCommand.js";
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths.js";
const DEBUG_ENV = "PICC_MEMORY_DEBUG";
export default async function (pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const { clearAutoMemPathCache } = await import("./paths.js");
			clearAutoMemPathCache();
			const files = await getLoadedMemoryFiles(ctx.cwd);
			const visible = files.filter(f => f.type !== "AutoMem");
			if (visible.length > 0) {
				ctx.ui.notify(
					`Memory: loaded ${visible.length} file${visible.length === 1 ? "" : "s"} ` +
						`(${visible.map(f => f.type.toLowerCase()).join(", ")})`,
					"info",
				);
			} else if (files.length === 0) {
				ctx.ui.notify("Memory: no CLAUDE.md or MEMORY.md files found.", "info");
			}
		} catch (err) {
			console.error("[picc-memory] session_start error:", err);
		}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!isAutoMemoryEnabled()) return;
			ensureMemoryDirExists(ctx.cwd);
			const imported = autoImportMemoryIfEmpty(getAutoMemPath(ctx.cwd), ctx.cwd);
			if (imported > 0) {
				ctx.ui.notify(`Memory: imported ${imported} file(s) from Claude Code.`, "info");
			}
			const block = await buildMemoryBlock(ctx);
			if (!block) return;
			const next = insertMemoryBlock(event.systemPrompt, block);
			if (
				process.env[DEBUG_ENV] === "1" ||
				process.env[DEBUG_ENV] === "true"
			) {
				console.log("=== picc-memory: final systemPrompt ===");
				console.log(next);
				console.log("=== end ===");
			}
			return { systemPrompt: next };
		} catch (err) {
			console.error("[picc-memory] before_agent_start error:", err);
		}
	});
	pi.registerCommand("memory", {
		description: "View and edit CLAUDE.md and AutoMem memory files",
		handler: async (_args, ctx) => {
			try {
				await showMemoryCommand(ctx);
			} catch (err) {
				ctx.ui.notify(
					`Memory command failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});
}
const PROJECT_CONTEXT_MARKER =
	"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
function insertMemoryBlock(basePrompt: string, block: string): string {
	const idx = basePrompt.indexOf(PROJECT_CONTEXT_MARKER);
	if (idx === -1) {
		return `${block}\n\n${basePrompt}`;
	}
	const before = basePrompt.slice(0, idx);
	const marker = basePrompt.slice(idx);
	return `${before}\n\n${block}\n\n${marker}`;
}
async function buildMemoryBlock(ctx: ExtensionContext): Promise<string | null> {
	const block = getMemoryPrompt(ctx.cwd,  true);
	if (!block) return null;
	if (process.env[DEBUG_ENV] === "1" || process.env[DEBUG_ENV] === "true") {
		console.log("=== picc-memory: systemPrompt injection ===");
		console.log(block);
		console.log("=== end ===");
	}
	return block;
}
