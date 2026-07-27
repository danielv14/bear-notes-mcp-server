# Bear MCP Server

An MCP server that integrates Bear notes with Claude Code.

## Architecture

This server uses a hybrid approach for best performance and safety:

| Operation | Method | Why |
|-----------|--------|-----|
| Read (search, get, list) | SQLite | Fast, reliable, no UI interaction |
| Write (create, append, prepend, trash, archive, rename-tag, delete-tag) | URL scheme | Safe, uses Bear's official API |

Reads and writes have different guarantees, and it is worth knowing which is
which before trusting a tool response. See [Behaviour notes](#behaviour-notes).

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
| `bear_search` | Search notes by text or tag (paged) |
| `bear_get_note` | Get full content of a note by ID, including its trashed/archived status |
| `bear_append` | Append text to an existing note |
| `bear_prepend` | Prepend text to the beginning of an existing note |
| `bear_replace_content` | Replace the entire content of an existing note |
| `bear_list_tags` | List all tags with note counts |
| `bear_list_by_tag` | List notes with a specific tag (paged) |
| `bear_rename_tag` | Rename an existing tag |
| `bear_delete_tag` | Delete an existing tag from all notes |
| `bear_trash_note` | Move a note to trash |
| `bear_archive_note` | Archive a note |
| `bear_list_archived` | List archived notes (paged) |

There is no un-archive tool: Bear's x-callback-url API has no `unarchive`
action, so it cannot be done from here. Un-archive in Bear's own UI.

## Example Usage in Claude

Once the server is running, you can ask Claude things like:

- "Search my Bear notes for 'project ideas'"
- "List all my tags in Bear"
- "Create a new note titled 'Meeting Notes' with today's date"
- "Show me all notes tagged with 'work'"
- "Append this summary to my 'Daily Log' note"
- "Rename my 'old-project' tag to 'archived-project'"
- "Delete the 'temp' tag from all notes"

## Database Location

The server automatically finds Bear's database in one of these locations:

- **iCloud sync:** `~/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite`
- **Local storage:** `~/Library/Containers/net.shinyfrog.bear/Data/Documents/Application Data/database.sqlite`

## Behaviour notes

**Writes are sent, not confirmed.** Every write goes out as a `bear://`
URL opened with `open -g`, which exits as soon as macOS finds a handler for
the scheme. Bear reports nothing back, so the server cannot tell an applied
change from one Bear ignored (an unknown note id, for instance). Write tools
therefore say what was *sent*, never that it was applied. A failure the server
*can* see - Bear not installed, or a payload too large to send - is returned as
an error result. If a write matters, verify it in Bear, or read the note back
with `bear_get_note`.

**Large notes are refused rather than truncated.** A `bear://` URL longer than
32000 characters (measured after percent-encoding, which inflates non-ASCII
text up to 3x) is not sent, and the tool returns an error naming the size.
Without the guard the write would be silently truncated, which under
`bear_replace_content` means overwriting a note with a partial copy. Split
large content across several `bear_append` calls.

**Timestamps are ISO-8601 UTC.** `createdAt` and `modifiedAt` come back as
`2026-07-27T06:09:00Z`. The trailing `Z` is deliberate: an unmarked
`2026-07-27 06:09:00` reads as local time and is off by the UTC offset, which
shifts the date for notes written in the first hours of the day.

**Search is case-insensitive for all characters, and literal.** `MÖTE` finds
`möte`, and `50%` finds the literal text `50%` rather than acting as a
wildcard. Case folding happens in JS because Bun's SQLite only folds ASCII.

**List results are paged.** `bear_search`, `bear_list_by_tag` and
`bear_list_archived` return `{ notes, count, limit, offset, hasMore }`. `count`
is the size of *that page*, never a total; `hasMore` says whether further notes
matched. Pass `limit` and `offset` to page through the rest.

## Logs

Logs are written to stderr, which Claude Code captures automatically. The
server reads no environment variables and has no log-level setting.

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

**"Unsupported Bear database schema"**
- Bear's note/tag join table is named after Core Data's generated entity ids,
  and those can change between Bear versions. The server discovers them from
  `Z_PRIMARYKEY` and fails with this message when the tables it needs are not
  where the discovery says they should be. Please open an issue with the Bear
  version, since it means the schema moved.
