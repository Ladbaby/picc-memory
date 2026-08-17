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
| AutoMem | `~/.claude/projects/<sanitized-git-root>/memory/MEMORY.md` + topic `.md` files | yes |
| Background extraction | Forked agent at end of each turn with restricted write-only-to-memory-dir tools | n/a |

A `/memory` slash command opens the file picker (TUI select) and spawns
`$VISUAL` / `$EDITOR` / `vim` for editing.

Loading order matches Claude Code exactly: Managed first (lowest priority, the
LLM sees them first), then User, then Project (parent → child as the walk
descends), then Local, then AutoMem. Prepended to the system prompt so it
sits before any AGENTS.md content.

## Storage

- **Memory base:** `~/.claude/` (matches Claude Code; we don't repurpose
  `~/.pi/agent/` for this).
- **AutoMem:** `~/.claude/projects/<sanitized-git-root>/memory/`
- **Topic file format:** YAML frontmatter with `name`, `description`, and
  `type` (one of `user`, `feedback`, `project`, `reference`), plus body.
- **Index file (`MEMORY.md`):** one `- [Title](file.md) — one-line hook` per
  topic. No frontmatter. Truncated to 200 lines OR 25 KB (whichever fires
  first) with a `> WARNING: MEMORY.md is ...` suffix naming the cap that fired.

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
