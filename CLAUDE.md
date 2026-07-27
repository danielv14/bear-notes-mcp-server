# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the server
bun run start

# Type check
bun run typecheck

# Unit tests (in-memory fixture, no Bear needed)
bun test

# Build
bun run build
```

## Testing

`bun test` runs against an in-memory SQLite fixture and a stubbed URL runner,
so a green suite proves the code agrees with the fixture - not that it agrees
with Bear. Bear ignores a bad `bear://` request silently, and `open` exits 0
either way, so a broken write path looks identical to a working one from here.

[docs/TEST-PROTOCOL.md](docs/TEST-PROTOCOL.md) closes that gap, and the
repo-local skill `/bear-protocol` runs it. It is a protocol for a Claude Code
session to walk through against the real app: create, read, modify, tag, archive
and trash one real test note through the **connected** `bear` MCP server,
confirming every write with a raw read-only `sqlite3` query rather than with our
own read code, plus two checkpoints only the user's eyes can answer.

There is deliberately no scripted end-to-end run. One existed
(`scripts/e2e-bear.ts`) and was removed: it verified every write by reading the
note back through `bear_get_note`, which makes our read path the witness for our
write path, so a shared bug passes. Its checks live in the protocol now. Do not
reintroduce it.

**After any change to the read queries, the write path, the tool surface, or the
note/URL rendering, walk the protocol before merging.** Say in the PR that it
ran, on which Bear and macOS version, and what was skipped.

`.github/workflows/ci.yml` runs `typecheck`, `bun test` and `bun run build` on
Linux for every push to `master` and every pull request. It cannot run the
protocol: that needs macOS, a Bear install, a real library and a human. Green CI
therefore means the code is internally consistent, not that Bear accepts it.

## Architecture

This is an MCP (Model Context Protocol) server that provides Claude Code access to Bear notes on macOS.

### Hybrid Read/Write Strategy

- **Read operations** (search, get, list): Direct SQLite queries against Bear's database (read-only mode)
- **Write operations** (create, append, prepend, replace, trash, archive, rename-tag, delete-tag): Bear's `bear://x-callback-url` scheme via `open` command

This separation ensures fast reads while using Bear's official API for safe writes.

Bear's URL scheme has no `unarchive` action, so archiving is one-way from here.
Writes are also fire-and-forget: `open` exits as soon as macOS finds a handler,
Bear reports nothing back, and tool responses say what was sent rather than
claiming it was applied.

### Source Files

- `src/server.ts` - MCP server setup and the declarative tool table using `@modelcontextprotocol/sdk`
- `src/bear.ts` - Core Bear operations (both SQLite reads and URL scheme writes)
- `src/database.ts` - SQLite connection management with auto-discovery of Bear's database location
- `src/bear-schema.ts` - Runtime discovery of Core Data's generated entity ids
- `src/notes-query.ts` - Shared SQL fragments and row-to-Note normalization
- `src/note-format.ts` - Pure note markdown rendering, tag normalization, URL building
- `src/text-match.ts` - Unicode-aware case folding used for all matching

### Bear Database Schema

Key tables for querying notes:
- `ZSFNOTE` - Notes table (`ZUNIQUEIDENTIFIER`, `ZTITLE`, `ZTEXT`, `ZTRASHED`, `ZARCHIVED`)
- `ZSFNOTETAG` - Tags table (`ZTITLE`)
- `Z_5TAGS` - Join table for note-tag relationships (`Z_5NOTES`, `Z_13TAGS`)
- `Z_PRIMARYKEY` - Core Data's entity registry (`Z_ENT`, `Z_NAME`)

**`Z_5TAGS` / `Z_5NOTES` / `Z_13TAGS` are not stable names.** The 5 and 13 are
Core Data's generated entity ids for `SFNote` and `SFNoteTag`; adding or
removing an entity in a future Bear release renumbers them. Do not hardcode
them - `src/bear-schema.ts` looks them up in `Z_PRIMARYKEY` and validates the
result, so a schema change produces an actionable error instead of "no such
table: Z_5TAGS" surfacing as a generic read failure.

Notes:
- Core Data epoch offset is 978307200 seconds from Unix epoch.
- `ZTRASHED` / `ZARCHIVED` can be NULL, so predicates use `IS NOT 1` rather
  than `= 0` (`NULL = 0` is NULL, which would silently hide the note).
- Bun's SQLite has no ICU, so `LIKE`, `LOWER()` and `UPPER()` only fold ASCII.
  All case-insensitive matching happens in JS (`src/text-match.ts`).
