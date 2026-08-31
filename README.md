# picc-memory

Replicate Claude Code's memory system on top of pi.

## What this extension does

Mirrors `claude-code`'s memory architecture byte-for-byte where possible. The
pi extension host supplies `before_agent_start`, `session_start`,
`agent_end`, and `registerCommand`; this extension wires them to:

| Layer | File(s) | Loaded into system prompt |
|---|---|---|
| Managed | `/etc/claude-code/CLAUDE.md` (Win: `C:\ProgramData\claude-code\CLAUDE.md`) + `/etc/claude-code/rules/*.md` | yes |
| User | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md` | yes |
| Project | `<cwd>/CLAUDE.md`, `<cwd>/.claude/CLAUDE.md`, `<cwd>/.claude/rules/*.md` (walk cwd → fs root) | yes |
| Local | `<cwd>/CLAUDE.local.md` (walk cwd → fs root) | yes |
| AutoMem | `<autoMemDir>/MEMORY.md` + topic `.md` files — see **Storage** for how `<autoMemDir>` is resolved | yes |
| Background extraction | Forked agent at end of each turn with restricted write-only-to-memory-dir tools | n/a |

A `/memory` slash command opens the file picker (TUI select) and spawns
`$VISUAL` / `$EDITOR` / `vim` for editing.

Loading order matches Claude Code exactly: Managed first (lowest priority, the
LLM sees them first), then User, then Project (parent → child as the walk
descends), then Local, then AutoMem. Prepended to the system prompt so it
sits before any AGENTS.md content.

## Storage

**AutoMem directory resolution** (first defined wins; base dirs get
`/projects/<sanitized-git-root>/memory/` appended, full dirs are used as-is):

1. `PICC_REMOTE_MEMORY_DIR` env var — base dir.
2. `autoMemoryDirectory` in `~/.pi/agent/extensions/picc-memory/config.json`
   (override location with `PICC_MEMORY_CONFIG_PATH`) — full dir.
3. `CLAUDE_CODE_REMOTE_MEMORY_DIR` env var — base dir.
4. `autoMemoryDirectory` in Claude Code's `~/.claude/settings.json` — full dir.
5. **Default:** `~/.pi/agent/extensions/picc-memory/projects/<sanitized-git-root>/memory/`
   (under the extension install dir, not `~/.claude`).

The `<sanitized-git-root>` key is produced by the same `sanitizePath`
Claude Code uses (non-alphanumeric → `-`, 200-char cap + djb2 hash), so it
matches Claude Code's project key exactly.

- **Auto-import from Claude Code:** on the first session in a project whose
  picc memory dir is still empty, the whole per-project memory folder
  (`MEMORY.md` + topic `.md` + `logs/`) is copied from where Claude Code keeps
  it (honoring `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, Claude's
  `autoMemoryDirectory`, and `CLAUDE_CODE_REMOTE_MEMORY_DIR`). Once the
  destination has any file it never imports again, and existing files are never
  overwritten.
- **Topic file format:** YAML frontmatter with `name`, `description`, and
  `type` (one of `user`, `feedback`, `project`, `reference`), plus body.
- **Index file (`MEMORY.md`):** one `- [Title](file.md) — one-line hook` per
  topic. No frontmatter. Truncated to 200 lines OR 25 KB (whichever fires
  first) with a `> WARNING: MEMORY.md is ...` suffix naming the cap that fired.
- The `projects/` tree is gitignored; user/managed CLAUDE.md still resolve
  from Claude Code's config home (`~/.claude`), independent of the memory base.

## Usage

```text
/memory                       # file picker → open in $EDITOR
> remember that I prefer terse responses
                              # AutoMem writes user_preference.md + MEMORY.md pointer
/memory                       # see the new entry appear
```

Env variables:
- `PICC_MEMORY_DEBUG=1` — print the first 500 chars of the assembled
  memory block on `before_agent_start` to the console (dev only).
- `PICC_REMOTE_MEMORY_DIR` — override the memory base dir (highest priority).
- `PICC_MEMORY_CONFIG_PATH` — override where `config.json` is read from.

## Known limitations

1. **No HTML comment stripping** in CLAUDE.md. `<!-- … -->` blocks survive
   loading. Claude Code uses `marked` Lexer to strip block-level comments;
   we skip the `marked` dependency in v1.
2. **No `@include` directive.** `@./path`, `@~/path`, `@/absolute/path` in
   CLAUDE.md is treated as plain text.
3. **No conditional rules.** `paths:` frontmatter glob-matching against
   the active file is not implemented.
4. **No `claudeMdExcludes` setting.** There is no per-pattern exclusion
   list.
5. **No symlink-loop detection** in the rules-directory graph.
6. **No TeamMem and no AgentMem.** TeamMem requires an Anthropic cloud
   backend. AgentMem is a sub-agent feature that pi-subagents already
   implements differently.
7. **`MEMORY.md` truncation is line + byte only.** No tag-aware truncation;
   entries past the cap disappear.

## Files

```
src/
├── index.ts            # extension factory, hooks, command registration
├── paths.ts            # memory path resolution (mirrors memdir/paths.ts)
├── memoryTypes.ts      # verbatim Claude Code taxonomy prose constants
├── memdir.ts           # ensureMemoryDirExists + truncateEntrypointContent
├── claudemd.ts         # file discovery + system prompt building
├── memoryScan.ts       # scanMemoryFiles + formatMemoryManifest
├── extractor.ts        # background forked extraction
└── memoryCommand.ts    # /memory picker + $EDITOR
```
