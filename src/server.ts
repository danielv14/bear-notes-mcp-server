import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger } from "./logger.js";
import { closeDatabase } from "./database.js";
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

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

const handleError = (error: unknown): ToolResult => {
  const message = error instanceof Error ? error.message : "An unknown error occurred";
  logger.error("Tool execution failed", { error });

  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true
  };
};

// Tool: Create note
server.tool(
  "bear_create_note",
  "Create a new note in Bear",
  {
    title: z.string().describe("Note title"),
    text: z.string().describe("Note content (Markdown)"),
    tags: z.array(z.string()).optional().describe("Tags to add to the note")
  },
  async ({ title, text, tags }): Promise<ToolResult> => {
    try {
      await createNote(title, text, tags);
      return {
        content: [{ type: "text", text: `Created note: ${title}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Search notes
server.tool(
  "bear_search",
  "Search for notes in Bear by text or tag",
  {
    term: z.string().optional().describe("Search term (free text)"),
    tag: z.string().optional().describe("Filter by tag (without #)")
  },
  async ({ term, tag }): Promise<ToolResult> => {
    try {
      const notes = searchNotes(term, tag);
      return {
        content: [{ type: "text", text: JSON.stringify(notes, null, 2) }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Get note content
server.tool(
  "bear_get_note",
  "Get the full content of a specific note",
  {
    noteId: z.string().describe("Note ID (from search results)")
  },
  async ({ noteId }): Promise<ToolResult> => {
    try {
      const note = getNoteContent(noteId);
      if (!note) {
        return {
          content: [{ type: "text", text: `Note not found: ${noteId}` }],
          isError: true
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(note, null, 2) }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Append to note
server.tool(
  "bear_append",
  "Append text to an existing note",
  {
    noteId: z.string().describe("Note ID (from search results)"),
    text: z.string().describe("Text to append")
  },
  async ({ noteId, text }): Promise<ToolResult> => {
    try {
      await appendToNote(noteId, text);
      return {
        content: [{ type: "text", text: `Appended text to note: ${noteId}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Prepend to note
server.tool(
  "bear_prepend",
  "Prepend text to the beginning of an existing note",
  {
    noteId: z.string().describe("Note ID (from search results)"),
    text: z.string().describe("Text to prepend")
  },
  async ({ noteId, text }): Promise<ToolResult> => {
    try {
      await prependToNote(noteId, text);
      return {
        content: [{ type: "text", text: `Prepended text to note: ${noteId}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Replace note content
server.tool(
  "bear_replace_content",
  "Replace the entire content of an existing note. Always structures the note as: title (H1) first, then tags, then content.",
  {
    noteId: z.string().describe("Note ID (from search results)"),
    title: z.string().describe("Note title (becomes the H1 heading on the first line)"),
    text: z.string().describe("New content (Markdown), placed after title and tags"),
    tags: z.array(z.string()).optional().describe("Tags to set on the note (placed between title and content)")
  },
  async ({ noteId, title, text, tags }): Promise<ToolResult> => {
    try {
      await replaceNoteContent(noteId, title, text, tags);
      return {
        content: [{ type: "text", text: `Replaced content of note: ${noteId}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: List all tags
server.tool(
  "bear_list_tags",
  "List all tags in Bear with note counts",
  {},
  async (): Promise<ToolResult> => {
    try {
      const tags = getAllTags();
      return {
        content: [{ type: "text", text: JSON.stringify(tags, null, 2) }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: List notes by tag
server.tool(
  "bear_list_by_tag",
  "List all notes with a specific tag",
  {
    tag: z.string().describe("Tag to filter by (without #)")
  },
  async ({ tag }): Promise<ToolResult> => {
    try {
      const notes = listNotesByTag(tag);
      const result = { tag, count: notes.length, notes };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Rename tag
server.tool(
  "bear_rename_tag",
  "Rename an existing tag in Bear",
  {
    name: z.string().describe("Current tag name (without #)"),
    newName: z.string().describe("New tag name (without #)")
  },
  async ({ name, newName }): Promise<ToolResult> => {
    try {
      await renameTag(name, newName);
      return {
        content: [{ type: "text", text: `Renamed tag '${name}' to '${newName}'` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Delete tag
server.tool(
  "bear_delete_tag",
  "Delete an existing tag from all notes in Bear",
  {
    name: z.string().describe("Tag name to delete (without #)")
  },
  async ({ name }): Promise<ToolResult> => {
    try {
      await deleteTag(name);
      return {
        content: [{ type: "text", text: `Deleted tag: ${name}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Trash note
server.tool(
  "bear_trash_note",
  "Move a note to trash",
  {
    noteId: z.string().describe("Note ID")
  },
  async ({ noteId }): Promise<ToolResult> => {
    try {
      await trashNote(noteId);
      return {
        content: [{ type: "text", text: `Moved note to trash: ${noteId}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Archive note
server.tool(
  "bear_archive_note",
  "Archive a note (moves it out of main view but keeps it accessible)",
  {
    noteId: z.string().describe("Note ID")
  },
  async ({ noteId }): Promise<ToolResult> => {
    try {
      await archiveNote(noteId);
      return {
        content: [{ type: "text", text: `Archived note: ${noteId}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: Unarchive note
server.tool(
  "bear_unarchive_note",
  "Restore an archived note back to the main view",
  {
    noteId: z.string().describe("Note ID")
  },
  async ({ noteId }): Promise<ToolResult> => {
    try {
      await unarchiveNote(noteId);
      return {
        content: [{ type: "text", text: `Unarchived note: ${noteId}` }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

// Tool: List archived notes
server.tool(
  "bear_list_archived",
  "List all archived notes",
  {},
  async (): Promise<ToolResult> => {
    try {
      const notes = listArchivedNotes();
      const result = { count: notes.length, notes };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return handleError(error);
    }
  }
);

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
  logger.info("Starting Bear MCP server");

  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    logger.info("Bear MCP server connected");
  } catch (error) {
    logger.error("Failed to start server", { error });
    process.exit(1);
  }
};

main();
