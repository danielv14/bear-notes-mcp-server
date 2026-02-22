# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the server
bun run start

# Type check
bun run typecheck

# Build
bun run build
```

## Architecture

This is an MCP (Model Context Protocol) server that provides Claude Code access to Bear notes on macOS.

### Hybrid Read/Write Strategy

- **Read operations** (search, get, list): Direct SQLite queries against Bear's database (read-only mode)
- **Write operations** (create, append, prepend, replace, trash, archive, rename-tag, delete-tag): Bear's `bear://x-callback-url` scheme via `open` command

This separation ensures fast reads while using Bear's official API for safe writes.

### Source Files

- `src/server.ts` - MCP server setup and tool definitions using `@modelcontextprotocol/sdk`
- `src/bear.ts` - Core Bear operations (both SQLite reads and URL scheme writes)
- `src/database.ts` - SQLite connection management with auto-discovery of Bear's database location
- `src/logger.ts` - Structured logging to stderr (configurable via `BEAR_MCP_LOG_LEVEL`)

### Bear Database Schema

Key tables for querying notes:
- `ZSFNOTE` - Notes table (`ZUNIQUEIDENTIFIER`, `ZTITLE`, `ZTEXT`, `ZTRASHED`)
- `ZSFNOTETAG` - Tags table (`ZTITLE`)
- `Z_5TAGS` - Join table for note-tag relationships (`Z_5NOTES`, `Z_13TAGS`)

Note: Core Data epoch offset is 978307200 seconds from Unix epoch.
