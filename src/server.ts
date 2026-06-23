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
  unarchiveNote,
  listArchivedNotes,
  renameTag,
  deleteTag,
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

// Every Bear tool, described as data. Adding a tool is adding a row; the
// try/catch and result shaping below are written once for all of them.
const tools: ToolDefinition[] = [
  defineTool({
    name: "bear_create_note",
    description: "Create a new note in Bear",
    inputSchema: z.object({
      title: z.string().describe("Note title"),
      text: z.string().describe("Note content (Markdown)"),
      tags: z.array(z.string()).optional().describe("Tags to add to the note")
    }),
    handler: async ({ title, text, tags }) => {
      await createNote(title, text, tags);
      return `Created note: ${title}`;
    }
  }),
  defineTool({
    name: "bear_search",
    description: "Search for notes in Bear by text or tag",
    inputSchema: z.object({
      term: z.string().optional().describe("Search term (free text)"),
      tag: z.string().optional().describe("Filter by tag (without #)")
    }),
    handler: ({ term, tag }) => searchNotes(term, tag)
  }),
  defineTool({
    name: "bear_get_note",
    description: "Get the full content of a specific note",
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
      return `Appended text to note: ${noteId}`;
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
      return `Prepended text to note: ${noteId}`;
    }
  }),
  defineTool({
    name: "bear_replace_content",
    description: "Replace the entire content of an existing note. Always structures the note as: title (H1) first, then tags, then content.",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID (from search results)"),
      title: z.string().describe("Note title (becomes the H1 heading on the first line)"),
      text: z.string().describe("New content (Markdown), placed after title and tags"),
      tags: z.array(z.string()).optional().describe("Tags to set on the note (placed between title and content)")
    }),
    handler: async ({ noteId, title, text, tags }) => {
      await replaceNoteContent(noteId, title, text, tags);
      return `Replaced content of note: ${noteId}`;
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
    description: "List all notes with a specific tag",
    inputSchema: z.object({
      tag: z.string().describe("Tag to filter by (without #)")
    }),
    handler: ({ tag }) => {
      const notes = listNotesByTag(tag);
      return { tag, count: notes.length, notes };
    }
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
      return `Renamed tag '${name}' to '${newName}'`;
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
      return `Deleted tag: ${name}`;
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
      return `Moved note to trash: ${noteId}`;
    }
  }),
  defineTool({
    name: "bear_archive_note",
    description: "Archive a note (moves it out of main view but keeps it accessible)",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID")
    }),
    handler: async ({ noteId }) => {
      await archiveNote(noteId);
      return `Archived note: ${noteId}`;
    }
  }),
  defineTool({
    name: "bear_unarchive_note",
    description: "Restore an archived note back to the main view",
    inputSchema: z.object({
      noteId: z.string().describe("Note ID")
    }),
    handler: async ({ noteId }) => {
      await unarchiveNote(noteId);
      return `Unarchived note: ${noteId}`;
    }
  }),
  defineTool({
    name: "bear_list_archived",
    description: "List all archived notes",
    inputSchema: z.object({}),
    handler: () => {
      const notes = listArchivedNotes();
      return { count: notes.length, notes };
    }
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

// Cleanup on exit
process.on("SIGINT", () => {
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDatabase();
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
