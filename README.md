# Bear MCP Server

An MCP server that integrates Bear notes with Claude Code.

## Architecture

This server uses a hybrid approach for best performance and safety:

| Operation | Method | Why |
|-----------|--------|-----|
| Read (search, get, list) | SQLite | Fast, reliable, no UI interaction |
| Write (create, append, trash) | URL scheme | Safe, uses Bear's official API |

## Requirements

- macOS (Bear is macOS/iOS only)
- [Bear](https://bear.app) installed
- [Bun](https://bun.sh) runtime

## Installation

```bash
cd bear-notes-mpc-server
bun install
```

## Claude Code Configuration

Add the MCP server using the Claude Code CLI:

```bash
claude mcp add --transport stdio --scope user bear -- bun run /absolute/path/to/bear-mcp-server/src/server.ts
```

> **Note:** Replace the path with the actual absolute path to your `bear-mcp-server` directory.

**Scope options:**
- `--scope user` - Available in all Claude Code sessions (recommended)
- `--scope local` - Only available in the current project directory
- `--scope project` - Creates `.mcp.json` for team sharing via git

**Check configured servers:**

```bash
claude mcp list
```

**View server details:**

```bash
claude mcp get bear
```

## Starting Claude with Bear Integration

Once the MCP server is configured, simply start a new Claude session:

```bash
claude
```

Claude will automatically start the Bear MCP server and you'll have access to all Bear tools.

## Removing the MCP Server

The MCP server runs as a subprocess of Claude Code and automatically stops when you exit Claude.

To permanently remove the server:

```bash
claude mcp remove bear
```

## Available Tools

| Tool | Description |
|------|-------------|
| `bear_create_note` | Create a new note with optional tags |
| `bear_search` | Search notes by text or tag |
| `bear_get_note` | Get full content of a note by ID |
| `bear_append` | Append text to an existing note |
| `bear_replace_content` | Replace the entire content of an existing note |
| `bear_list_tags` | List all tags with note counts |
| `bear_list_by_tag` | List all notes with a specific tag |
| `bear_trash_note` | Move a note to trash |

## Example Usage in Claude

Once the server is running, you can ask Claude things like:

- "Search my Bear notes for 'project ideas'"
- "List all my tags in Bear"
- "Create a new note titled 'Meeting Notes' with today's date"
- "Show me all notes tagged with 'work'"
- "Append this summary to my 'Daily Log' note"

## Database Location

The server automatically finds Bear's database in one of these locations:

- **iCloud sync:** `~/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite`
- **Local storage:** `~/Library/Containers/net.shinyfrog.bear/Data/Documents/Application Data/database.sqlite`

## Logs

Logs are written to stderr, which Claude Code captures automatically.

To enable debug logging, add the server with the `--env` flag:

```bash
claude mcp add --transport stdio --scope user --env BEAR_MCP_LOG_LEVEL=debug bear -- bun run /absolute/path/to/bear-mcp-server/src/server.ts
```

Log levels: `debug`, `info` (default), `warn`, `error`

## Permissions

On first run, macOS may ask for Automation permissions to allow the server to open Bear URLs.

## Troubleshooting

**"Bear database not found"**
- Make sure Bear is installed and has been opened at least once

**Notes not appearing after create**
- Bear may take a moment to sync. The note is created via URL scheme and may not immediately appear in SQLite queries.

**Permission denied on database**
- The database is opened in read-only mode. If you still get errors, check that Bear isn't currently writing to the database.

**MCP server not connecting**
- Verify the path in your config is correct
- Run `claude mcp list` to check if the server is configured
- Ensure Bun is installed and available in your PATH
