/**
 * picc-memory — Claude Code-style memory system for pi.
 *
 * Replicates claude-code's memory system byte-for-byte where possible:
 *
 *   - 5-layer CLAUDE.md discovery (Managed → User → Project → Local → AutoMem)
 *   - AutoMem (persistent personal memory) with 4-type taxonomy
 *   - /memory slash command with file picker + $EDITOR launch
 *   - Optional background forked extraction (opt-in via env var; requires
 *     pi-subagents via cross-extension RPC)
 *
 * Loaded by jiti from `~/.pi/agent/extensions/picc-memory/src/index.ts`.
 *
 * Hooks:
 *   - session_start    → prime caches, notify how many memory files loaded
 *   - before_agent_start → prepend memory block to systemPrompt
 *   - agent_end        → trigger background extractor (if enabled)
 *   - session_shutdown → drain in-flight extraction
 *
 * Commands:
 *   - /memory          → picker UI for editing CLAUDE.md / MEMORY.md / rules
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureMemoryDirExists } from "./memdir.js";
import { getMemoryPrompt, getLoadedMemoryFiles } from "./claudemd.js";
import { autoImportMemoryIfEmpty } from "./importFromClaude.js";
import { showMemoryCommand } from "./memoryCommand.js";
import { initExtractor, type ExtractorHandle } from "./extractor.js";
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths.js";

// ============================================================================
// Constants
// ============================================================================

const DEBUG_ENV = "PICC_MEMORY_DEBUG";

// ============================================================================
// Extension factory
// ============================================================================

export default async function (pi: ExtensionAPI): Promise<void> {
	// ────────────────────────────────────────────────────────────────
	// Background extraction — initialised once at extension load.
	// ────────────────────────────────────────────────────────────────

	const extractor: ExtractorHandle = await initExtractor(pi);

	// ────────────────────────────────────────────────────────────────
	// session_start — notify the user about how many memory files
	// were discovered for this cwd, and clear any stale memoisation.
	// ────────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			// AutoMem path resolves per-cwd and is memoised there; on cwd
			// change, drop the cache so the new location is picked up.
			const { clearAutoMemPathCache } = await import("./paths.js");
			clearAutoMemPathCache();

			const files = await getLoadedMemoryFiles(ctx.cwd);
			// AutoMem is implicit (always exists in spirit) — count just
			// the CLAUDE.md layers so the message stays clean.
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
			// Note: AutoMem directory creation happens in before_agent_start
			// because session_start doesn't fire under pi -p (print mode).
		} catch (err) {
			console.error("[picc-memory] session_start error:", err);
		}
	});

	// ────────────────────────────────────────────────────────────────
	// before_agent_start — prepend the assembled memory block to the
	// system prompt. Order matters: Managed first (lowest priority),
	// User, Project, Local, AutoMem last (highest priority). We
	// prepend in front of pi's own AGENTS.md content so the LLM sees
	// memory rules BEFORE it sees any project-specific AGENTS.md.
	// (Matches claude-code's lowest-priority-loads-first convention.)
	// ────────────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Kill-switch: PICC_DISABLE_AUTO_MEMORY / CLAUDE_CODE_DISABLE_AUTO_MEMORY
			// truthy → leave the system prompt untouched. CLAUDE.md layers are
			// still loaded so /memory picker still works.
			if (!isAutoMemoryEnabled()) return;

			// Idempotent — prepare the AutoMem directory so the LLM can
			// write to it without first asking "does this directory
			// exist?". Also fires under pi -p (print mode).
			ensureMemoryDirExists(ctx.cwd);

			// One-time migration: if this project's picc memory dir is still
			// empty, copy the whole per-project memory folder over from Claude
			// Code. Safe to call every turn — no-op once the destination has
			// any file (see importFromClaude.ts).
			const imported = autoImportMemoryIfEmpty(getAutoMemPath(ctx.cwd), ctx.cwd);
			if (imported > 0) {
				ctx.ui.notify(`Memory: imported ${imported} file(s) from Claude Code.`, "info");
			}

			const block = await buildMemoryBlock(ctx);
			if (!block) return; // no memory files — leave the prompt untouched

			return {
				systemPrompt: `${block}\n\n${event.systemPrompt}`,
			};
		} catch (err) {
			console.error("[picc-memory] before_agent_start error:", err);
		}
	});

	// ────────────────────────────────────────────────────────────────
	// agent_end — fire-and-forget background extraction (opt-in).
	// ────────────────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!extractor.enabled) return;
		try {
			extractor.schedule(ctx);
		} catch (err) {
			console.error("[picc-memory] agent_end error:", err);
		}
	});

	// ────────────────────────────────────────────────────────────────
	// session_shutdown — drain any in-flight extraction so forked
	// agents can finish cleanly before the process tears down.
	// ────────────────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		if (!extractor.enabled) return;
		try {
			await extractor.drain(30_000);
		} catch {
			// best-effort
		}
	});

	// ────────────────────────────────────────────────────────────────
	// /memory — open the file picker, edit the selected file in $EDITOR.
	// ────────────────────────────────────────────────────────────────

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

// ============================================================================
// Memory-block assembly
// ============================================================================

/**
 * GetMemoryPrompt is sync; assemble, optionally log a debug preview.
 *
 * Pass `onlyAutoMem: true` so the system-prompt injection only carries the
 * AutoMem layer. pi core already injects CLAUDE.md / AGENTS.md natively
 * at startup (see `docs/quickstart.md` and `docs/usage.md` in
 * `@earendil-works/pi-coding-agent`); re-injecting them here caused the
 * same content to appear twice. The `/memory` picker, the background
 * extractor, and the `session_start` notification all still use
 * `getLoadedMemoryFiles()` without the flag so they see the full 5 layers.
 */
async function buildMemoryBlock(ctx: ExtensionContext): Promise<string | null> {
	const block = getMemoryPrompt(ctx.cwd, /* onlyAutoMem */ true);
	if (!block) return null;
	if (process.env[DEBUG_ENV] === "1" || process.env[DEBUG_ENV] === "true") {
		// eslint-disable-next-line no-console
		console.log("=== picc-memory: systemPrompt injection ===");
		// eslint-disable-next-line no-console
		console.log(block);
		// eslint-disable-next-line no-console
		console.log("=== end ===");
	}
	return block;
}
