import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeDatabase } from "./database.js";
import { type ToolResult, toToolResult, handleError } from "./tool-result.js";
import {
  createNote,
  searchNotes,
  getNoteContent,
  appendToNote,
  prependToNote,
  replaceNoteContent,
  listNotesByTag,
  getAllTags,
  trashNote,
  archiveNote,
  listArchivedNotes,
  renameTag,
  deleteTag,
  MAX_LIMIT,
} from "./bear.js";

const server = new McpServer({
  name: "bear",
  version: "1.0.0"
});

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  // Returns the success payload. Throw to produce an error result; a thrown
  // error's message is surfaced via handleError.
  handler: (args: any) => Promise<string | object> | string | object;
}

// Wraps a single definition so each handler's args are type-checked against
// that tool's own inputSchema, while the array stays one uniform table.
const defineTool = <Schema extends z.ZodObject<any>>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: z.infer<Schema>) => Promise<string | object> | string | object;
}): ToolDefinition => definition;

// A blank title would render as a bare "# " H1, and under mode=replace_all
// that empty heading overwrites the note's real title. Rejected at the
// boundary rather than repaired further in.
const noteTitle = z.string().trim().min(1, "Note title must not be empty");

// Pagination, shared by every list-shaped tool. Defaults live in bear.ts so
// omitting them keeps each tool's own historical page size.
const paginationSchema = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional()
    .describe(`Maximum notes to return (max ${MAX_LIMIT})`),
  offset: z.number().int().min(0).optional()
    .describe("Number of matching notes to skip, for paging past the first page"),
};

// Bear's URL scheme is fire-and-forget: `open` returns as soon as macOS finds
// a handler for bear://, and Bear reports nothing back. A write tool can only
// honestly state what it sent, never that the change landed.
const sentToBear = (what: string): string =>
  `Sent to Bear: ${what}. Bear does not report back, so this is not confirmation that it was applied.`;

// Every Bear tool, described as data. Adding a tool is adding a row; the
// try/catch and result shaping below are written once for all of them.
const tools: ToolDefinition[] = [
  defineTool({
    name: "bear_create_note",
    description: "Create a new note in Bear",
    inputSchema: z.object({
      title: noteTitle.describe("Note title"),
      text: z.string().describe("Note content (Markdown)"),
      tags: z.array(z.string()).optional().describe("Tags to add to the note (a leading # is optional)")
    }),
    handler: async ({ title, text, tags }) => {
      await createNote(title, text, tags);
      return sentToBear(`create note "${title}"`);
    }
  }),
  defineTool({
    name: "bear_search",
    description: "Search for notes in Bear by text or tag. Matching is case-insensitive, including for non-ASCII characters, and the term matches literally (no wildcards). Returns one page of notes: `count` is the size of that page, and `hasMore` says whether further notes matched.",
    inputSchema: z.object({
      term: z.string().optional().describe("Search term (free text). Blank means no text filter."),
      tag: z.string().optional().describe("Filter by tag (a leading # is optional). Blank means no tag filter."),
      ...paginationSchema,
    }),
    handler: ({ term, tag, limit, offset }) => searchNotes({ term, tag, limit, offset })
  }),
  defineTool({
    name: "bear_get_note",
    description: "Get the full content of a specific note. Works for trashed and archived notes too; the isTrashed and isArchived fields say which.",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID (from search results)")
    }),
    handler: ({ noteId }) => {
      const note = getNoteContent(noteId);
      if (!note) throw new Error(`Note not found: ${noteId}`);
      return note;
    }
  }),
  defineTool({
    name: "bear_append",
    description: "Append text to an existing note",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID (from search results)"),
      text: z.string().describe("Text to append")
    }),
    handler: async ({ noteId, text }) => {
      await appendToNote(noteId, text);
      return sentToBear(`append text to note ${noteId}`);
    }
  }),
  defineTool({
    name: "bear_prepend",
    description: "Prepend text to the beginning of an existing note",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID (from search results)"),
      text: z.string().describe("Text to prepend")
    }),
    handler: async ({ noteId, text }) => {
      await prependToNote(noteId, text);
      return sentToBear(`prepend text to note ${noteId}`);
    }
  }),
  defineTool({
    name: "bear_replace_content",
    description: "Replace the entire content of an existing note. Always structures the note as: title (H1) first, then tags, then content.",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID (from search results)"),
      title: noteTitle.describe("Note title (becomes the H1 heading on the first line)"),
      text: z.string().describe("New content (Markdown), placed after title and tags"),
      tags: z.array(z.string()).optional().describe("Tags to set on the note (placed between title and content; a leading # is optional)")
    }),
    handler: async ({ noteId, title, text, tags }) => {
      await replaceNoteContent(noteId, title, text, tags);
      return sentToBear(`replace the content of note ${noteId}`);
    }
  }),
  defineTool({
    name: "bear_list_tags",
    description: "List all tags in Bear with note counts",
    inputSchema: z.object({}),
    handler: () => getAllTags()
  }),
  defineTool({
    name: "bear_list_by_tag",
    description: "List notes with a specific tag. Returns one page: `count` is the size of that page, and `hasMore` says whether further notes carry the tag.",
    inputSchema: z.object({
      tag: z.string().trim().min(1, "Tag must not be blank").describe("Tag to filter by (a leading # is optional)"),
      ...paginationSchema,
    }),
    handler: ({ tag, limit, offset }) => ({ tag, ...listNotesByTag(tag, { limit, offset }) })
  }),
  defineTool({
    name: "bear_rename_tag",
    description: "Rename an existing tag in Bear",
    inputSchema: z.object({
      name: z.string().describe("Current tag name (without #)"),
      newName: z.string().describe("New tag name (without #)")
    }),
    handler: async ({ name, newName }) => {
      await renameTag(name, newName);
      return sentToBear(`rename tag '${name}' to '${newName}'`);
    }
  }),
  defineTool({
    name: "bear_delete_tag",
    description: "Delete an existing tag from all notes in Bear",
    inputSchema: z.object({
      name: z.string().describe("Tag name to delete (without #)")
    }),
    handler: async ({ name }) => {
      await deleteTag(name);
      return sentToBear(`delete tag '${name}'`);
    }
  }),
  defineTool({
    name: "bear_trash_note",
    description: "Move a note to trash",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID")
    }),
    handler: async ({ noteId }) => {
      await trashNote(noteId);
      return sentToBear(`move note ${noteId} to trash`);
    }
  }),
  defineTool({
    name: "bear_archive_note",
    description: "Archive a note (moves it out of main view but keeps it accessible). Bear's URL scheme has no un-archive action, so this cannot be undone from here - only in Bear itself.",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID")
    }),
    handler: async ({ noteId }) => {
      await archiveNote(noteId);
      return sentToBear(`archive note ${noteId}`);
    }
  }),
  defineTool({
    name: "bear_list_archived",
    description: "List archived notes. Returns one page: `count` is the size of that page, and `hasMore` says whether more archived notes exist.",
    inputSchema: z.object({ ...paginationSchema }),
    handler: ({ limit, offset }) => listArchivedNotes({ limit, offset })
  })
];

for (const tool of tools) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema },
    async (args: any): Promise<ToolResult> => {
      try {
        return toToolResult(await tool.handler(args));
      } catch (error) {
        return handleError(error);
      }
    }
  );
}

// One cleanup for every shutdown path. closeDatabase() nulls its handle, so
// calling it more than once is safe.
const shutdown = (): void => {
  closeDatabase();
};

// The path that actually happens: Claude Code shuts a stdio server down by
// closing its stdin, which ends the transport without delivering a signal.
// No process.exit here, so a normal shutdown can drain.
server.server.onclose = shutdown;

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

// Start server
const main = async () => {
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    console.error("Bear MCP server connected");
  } catch (error) {
    console.error("Failed to start server", error);
    process.exit(1);
  }
};

main();
