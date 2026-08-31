# picc-memory

[![npm downloads](https://img.shields.io/npm/dt/@ladbabynpm/picc-memory.svg)](https://www.npmjs.com/package/@ladbabynpm/picc-memory)

Claude Code style persistent memory system for pi.
Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.
Replicates Claude Code's 5-layer `CLAUDE.md` discovery plus its **AutoMem** persistent-personal-memory system (the 4-type taxonomy, `MEMORY.md` index, `how/when to save` system-prompt instructions).
Layer ordering, discovery, truncation caps, taxonomy prose, and the `MEMORY.md` index format all mirror Claude Code (`memdir/memdir.ts`, `memdir/memoryTypes.ts`, `utils/claudemd.ts`) — see the **Files** section for which Claude Code module each file was ported from.

## Layers loaded into the system prompt

| Layer | File(s) | Loaded into system prompt |
|------|---------|---------------------------|
| Managed | `/etc/claude-code/CLAUDE.md` (Win: `C:\ProgramData\claude-code\CLAUDE.md`) + `/etc/claude-code/rules/*.md` | yes |
| User | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md` | yes |
| Project | `<cwd>/CLAUDE.md`, `<cwd>/.claude/CLAUDE.md`, `<cwd>/.claude/rules/*.md` (walk cwd → fs root) | yes |
| Local | `<cwd>/CLAUDE.local.md` (walk cwd → fs root) | yes |
| AutoMem | `<autoMemDir>/MEMORY.md` + topic `.md` files — see **Storage** for how `<autoMemDir>` is resolved | yes |
| Background extraction | Forked agent at end of each turn (opt-in) with write-only-to-memory-dir tools | n/a |

Loading order matches Claude Code exactly: Managed first (lowest priority —
the LLM sees them first), then User, then Project (parent → child as the walk
descends), then Local, then AutoMem. The block is **prepended** to the system
prompt so it sits before any `AGENTS.md` content.

## Commands

| Command | Purpose |
|------|---------|
| `/memory` | Open a TUI file picker across all 5 layers and edit the selected file in `$VISUAL` / `$EDITOR` / `vim`. In non-UI (print/RPC) mode falls back to a `notify` listing the discovered files. |

## Usage

```text
/memory                       # file picker → open in $EDITOR
> remember that I prefer terse responses
                              # AutoMem writes user_preference.md + a MEMORY.md pointer
/memory                       # see the new entry appear
```

The AutoMem behavioral instructions (the 4-type taxonomy, "what NOT to save",
the two-step save flow, when to access, and the memory-vs-plan-vs-task
distinction) are injected into the system prompt on **every** turn via
`before_agent_start` — including on a fresh project where `MEMORY.md` does not
exist yet — so the model learns to create and maintain memory from the first
conversation.

## Storage

**AutoMem directory resolution** (first defined wins). *Base* dirs get
`/projects/<sanitized-git-root>/memory/` appended; *full* dirs are used as-is:

| # | Source | Kind |
|---|--------|------|
| 1 | `PICC_REMOTE_MEMORY_DIR` env var | base dir |
| 2 | `autoMemoryDirectory` in `~/.pi/agent/extensions/picc-memory/config.json` (override location with `PICC_MEMORY_CONFIG_PATH`) | full dir |
| 3 | `CLAUDE_CODE_REMOTE_MEMORY_DIR` env var | base dir |
| 4 | `autoMemoryDirectory` in Claude Code's `~/.claude/settings.json` | full dir |
| 5 | **Default** — `~/.pi/agent/extensions/picc-memory/projects/<sanitized-git-root>/memory/` | base dir |

The `<sanitized-git-root>` key is produced by the same `sanitizePath` Claude
Code uses (non-alphanumeric → `-`, 200-char cap + djb2 hash), so it matches
Claude Code's project key exactly — which is what makes the auto-import below
unambiguous.

### Auto-import from Claude Code

On the first session in a project whose picc memory dir is still empty, the
whole per-project memory folder (`MEMORY.md` + topic `.md` + `logs/`) is copied
from where Claude Code keeps it (honoring `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`,
Claude's `autoMemoryDirectory`, and `CLAUDE_CODE_REMOTE_MEMORY_DIR`). The
import is **idempotent**: once the destination holds any file it never runs
again, and existing destination files are never overwritten.

### File format

- **Topic files** use YAML frontmatter with `name`, `description`, and `type`
  (one of `user`, `feedback`, `project`, `reference`), plus a body.
- **Index file (`MEMORY.md`)** — one `- [Title](file.md) — one-line hook` per
  topic, no frontmatter. Truncated to 200 lines OR 25 KB (whichever fires
  first) with a `> WARNING: MEMORY.md is ...` suffix naming the cap that fired.
- The `projects/` tree is gitignored. User/Managed `CLAUDE.md` still resolve
  from Claude Code's config home (`~/.claude`), independent of the memory base.

## Configuration

**`autoMemoryDirectory`** is set via the extension's `config.json` at
`~/.pi/agent/extensions/picc-memory/config.json` (copy
`config.json.example` to `config.json` to enable):

```json
{ "autoMemoryDirectory": "/abs/path/to/memory" }
```

The `PICC_MEMORY_CONFIG_PATH` env var overrides where `config.json` is read
from. `autoMemoryDirectory` is a *full* dir (used as-is, `~/` expanded); the
two `*_REMOTE_MEMORY_DIR` env vars are *base* dirs.

### Environment variables

| Env var | Default | Effect |
|---------|---------|--------|
| `PICC_REMOTE_MEMORY_DIR` | (unset) | Override the memory base dir — **highest priority**. Appends `/projects/<sanitized>/memory/`. |
| `PICC_MEMORY_CONFIG_PATH` | `~/.pi/agent/extensions/picc-memory/config.json` | Where `autoMemoryDirectory` is read from. |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | (unset) | Claude Code's remote memory base dir; consulted after picc's own settings (priority #3). |
| `PICC_MEMORY_EXTRA_GUIDELINES` / `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | (unset) | Extra guidance bullets appended to the AutoMem instructions (picc's name wins). |
| `PICC_DISABLE_AUTO_MEMORY` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | (unset) | Kill switch — when truthy, AutoMem instructions and auto-import are skipped (CLAUDE.md layers still load). |
| `PICC_MEMORY_EXTRACTION` | (unset) | When truthy, enables the opt-in background forked extraction at `agent_end` (requires `@ladbabynpm/picc-subagents`). |
| `PICC_MEMORY_EXTRACTION_INTERVAL` / `PICC_MEMORY_EXTRACTION_MAX_TURNS` | `1` / `5` | Throttle and per-session turn cap for the background extractor. |
| `PICC_MEMORY_EXTRACTION_MODEL` | (unset) | Optional model override for the forked extraction agent. |
| `PICC_MEMORY_DEBUG` | (unset) | When `1`, log the assembled memory block on `before_agent_start` (dev only). |

## Hooks

| Hook | Effect |
|------|--------|
| `session_start` | Clear the per-cwd path cache; `notify` how many `CLAUDE.md` files were discovered. |
| `before_agent_start` | `ensureMemoryDirExists`, run the one-time Claude Code auto-import, then prepend the memory block to `systemPrompt`. |
| `agent_end` | Fire-and-forget background extraction (only when enabled). |
| `session_shutdown` | Drain in-flight extraction with a 30 s timeout. |

## Differences from Claude Code

These are intentionally out of scope for picc-memory.

- **No HTML comment stripping** in `CLAUDE.md`. `<!-- … -->` blocks survive loading. Claude Code uses a `marked` Lexer to strip block-level comments; we skip the `marked` dependency.
- **No `@include` directive.** `@./path`, `@~/path`, `@/absolute/path` in `CLAUDE.md` is treated as plain text.
- **No conditional rules.** `paths:` frontmatter glob-matching against the active file is not implemented.
- **No `claudeMdExcludes` setting.** There is no per-pattern exclusion list.
- **No symlink-loop detection** in the rules-directory graph.
- **No TeamMem and no AgentMem.** TeamMem requires an Anthropic cloud backend; AgentMem is a sub-agent feature `@ladbabynpm/picc-subagents` implements differently.
- **`MEMORY.md` truncation is line + byte only.** No tag-aware truncation; entries past the cap disappear.
- **Default memory base differs.** Claude Code defaults to `~/.claude/`; picc-memory defaults to `~/.pi/agent/extensions/picc-memory/`. The auto-import bridges the two for existing Claude Code projects.

## Files

```
src/
├── index.ts            # extension factory, hooks, command registration
├── paths.ts            # memory path resolution + sanitizePath (mirrors memdir/paths.ts)
├── importFromClaude.ts # one-time auto-import of a project's memory from Claude Code
├── memoryTypes.ts      # verbatim Claude Code taxonomy prose constants
├── memdir.ts           # ensureMemoryDirExists + truncateEntrypointContent
├── claudemd.ts         # file discovery + system prompt building
├── memoryScan.ts       # scanMemoryFiles + formatMemoryManifest
├── extractor.ts        # background forked extraction
└── memoryCommand.ts    # /memory picker + $EDITOR
```
