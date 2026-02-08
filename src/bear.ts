import { execFile } from "child_process";
import { promisify } from "util";
import { getDatabase, DatabaseError } from "./database.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface Note {
  id: string;
  title: string;
  content?: string;
  tags?: string[];
  createdAt?: string;
  modifiedAt?: string;
  isTrashed?: boolean;
}

export interface Tag {
  name: string;
  noteCount: number;
}

export class BearError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BearError";
  }
}

// ============================================================================
// WRITE OPERATIONS (via URL scheme - safe)
// ============================================================================

const callBearUrl = async (action: string, params: Record<string, string>): Promise<void> => {
  const encodedParams = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  const url = `bear://x-callback-url/${action}?${encodedParams}`;

  try {
    await execFileAsync("open", [url]);
    logger.debug("Called Bear URL", { action, params });
  } catch (error) {
    logger.error("Bear URL call failed", { action, params, error });
    throw new BearError(`Failed to call Bear action: ${action}`, error);
  }
};

export const createNote = async (title: string, text: string, tags?: string[]): Promise<void> => {
  let fullText = "";
  if (tags?.length) {
    fullText = tags.map(t => `#${t}`).join(" ") + "\n\n";
  }
  fullText += text;
  await callBearUrl("create", { title, text: fullText });
  logger.info("Created note", { title, tags });
};

export const appendToNote = async (noteId: string, text: string): Promise<void> => {
  await callBearUrl("add-text", { id: noteId, text, mode: "append" });
  logger.info("Appended to note", { noteId });
};

export const replaceNoteContent = async (noteId: string, text: string, tags?: string[]): Promise<void> => {
  let fullText = "";
  if (tags?.length) {
    fullText = tags.map(t => `#${t}`).join(" ") + "\n\n";
  }
  fullText += text;
  await callBearUrl("add-text", { id: noteId, text: fullText, mode: "replace_all" });
  logger.info("Replaced note content", { noteId, tags });
};

export const trashNote = async (noteId: string): Promise<void> => {
  await callBearUrl("trash", { id: noteId });
  logger.info("Trashed note", { noteId });
};

export const archiveNote = async (noteId: string): Promise<void> => {
  await callBearUrl("archive", { id: noteId });
  logger.info("Archived note", { noteId });
};

export const unarchiveNote = async (noteId: string): Promise<void> => {
  await callBearUrl("unarchive", { id: noteId });
  logger.info("Unarchived note", { noteId });
};

// ============================================================================
// READ OPERATIONS (via SQLite - fast)
// ============================================================================

const getNoteTags = (noteId: string): string[] => {
  return getNoteTagsBatch([noteId])[noteId] ?? [];
};

const getNoteTagsBatch = (noteIds: string[]): Record<string, string[]> => {
  if (noteIds.length === 0) return {};

  const db = getDatabase();
  const placeholders = noteIds.map(() => "?").join(", ");

  const query = `
    SELECT n.ZUNIQUEIDENTIFIER as noteId, t.ZTITLE as name
    FROM ZSFNOTETAG t
    JOIN Z_5TAGS nt ON t.Z_PK = nt.Z_13TAGS
    JOIN ZSFNOTE n ON nt.Z_5NOTES = n.Z_PK
    WHERE n.ZUNIQUEIDENTIFIER IN (${placeholders})
    ORDER BY t.ZTITLE
  `;

  const rows = db.prepare(query).all(...noteIds) as { noteId: string; name: string }[];

  const result: Record<string, string[]> = {};
  for (const row of rows) {
    if (!result[row.noteId]) result[row.noteId] = [];
    result[row.noteId].push(row.name);
  }
  return result;
};

export const searchNotes = (term?: string, tag?: string): Note[] => {
  const db = getDatabase();

  try {
    let query: string;
    let params: string[];

    if (tag) {
      // Search by tag
      query = `
        SELECT DISTINCT
          n.ZUNIQUEIDENTIFIER as id,
          n.ZTITLE as title,
          n.ZTEXT as content,
          datetime(n.ZCREATIONDATE + 978307200, 'unixepoch') as createdAt,
          datetime(n.ZMODIFICATIONDATE + 978307200, 'unixepoch') as modifiedAt,
          n.ZTRASHED as isTrashed
        FROM ZSFNOTE n
        JOIN Z_5TAGS nt ON n.Z_PK = nt.Z_5NOTES
        JOIN ZSFNOTETAG t ON nt.Z_13TAGS = t.Z_PK
        WHERE t.ZTITLE LIKE ?
          AND n.ZTRASHED = 0
          AND n.ZARCHIVED = 0
        ORDER BY n.ZMODIFICATIONDATE DESC
        LIMIT 100
      `;
      params = [`%${tag}%`];
    } else if (term) {
      // Search by text
      query = `
        SELECT
          ZUNIQUEIDENTIFIER as id,
          ZTITLE as title,
          ZTEXT as content,
          datetime(ZCREATIONDATE + 978307200, 'unixepoch') as createdAt,
          datetime(ZMODIFICATIONDATE + 978307200, 'unixepoch') as modifiedAt,
          ZTRASHED as isTrashed
        FROM ZSFNOTE
        WHERE (ZTITLE LIKE ? OR ZTEXT LIKE ?)
          AND ZTRASHED = 0
          AND ZARCHIVED = 0
        ORDER BY ZMODIFICATIONDATE DESC
        LIMIT 100
      `;
      params = [`%${term}%`, `%${term}%`];
    } else {
      // Return recent notes
      query = `
        SELECT
          ZUNIQUEIDENTIFIER as id,
          ZTITLE as title,
          datetime(ZCREATIONDATE + 978307200, 'unixepoch') as createdAt,
          datetime(ZMODIFICATIONDATE + 978307200, 'unixepoch') as modifiedAt,
          ZTRASHED as isTrashed
        FROM ZSFNOTE
        WHERE ZTRASHED = 0
          AND ZARCHIVED = 0
        ORDER BY ZMODIFICATIONDATE DESC
        LIMIT 50
      `;
      params = [];
    }

    const rows = db.prepare(query).all(...params) as Note[];
    const tagsByNote = getNoteTagsBatch(rows.map(n => n.id));

    return rows.map(note => ({
      ...note,
      isTrashed: Boolean(note.isTrashed),
      tags: tagsByNote[note.id] ?? [],
      content: undefined // Don't include full content in search results
    }));
  } catch (error) {
    logger.error("Search failed", { term, tag, error });
    throw new DatabaseError("Failed to search notes", error);
  }
};

export const getNoteContent = (noteId: string): Note | null => {
  const db = getDatabase();

  try {
    const query = `
      SELECT
        ZUNIQUEIDENTIFIER as id,
        ZTITLE as title,
        ZTEXT as content,
        datetime(ZCREATIONDATE + 978307200, 'unixepoch') as createdAt,
        datetime(ZMODIFICATIONDATE + 978307200, 'unixepoch') as modifiedAt,
        ZTRASHED as isTrashed
      FROM ZSFNOTE
      WHERE ZUNIQUEIDENTIFIER = ?
    `;

    const note = db.prepare(query).get(noteId) as Note | undefined;

    if (!note) return null;

    return {
      ...note,
      isTrashed: Boolean(note.isTrashed),
      tags: getNoteTags(noteId)
    };
  } catch (error) {
    logger.error("Failed to get note", { noteId, error });
    throw new DatabaseError("Failed to get note content", error);
  }
};

export const listNotesByTag = (tag: string): Note[] => {
  const db = getDatabase();

  try {
    const query = `
      SELECT DISTINCT
        n.ZUNIQUEIDENTIFIER as id,
        n.ZTITLE as title,
        datetime(n.ZCREATIONDATE + 978307200, 'unixepoch') as createdAt,
        datetime(n.ZMODIFICATIONDATE + 978307200, 'unixepoch') as modifiedAt
      FROM ZSFNOTE n
      JOIN Z_5TAGS nt ON n.Z_PK = nt.Z_5NOTES
      JOIN ZSFNOTETAG t ON nt.Z_13TAGS = t.Z_PK
      WHERE LOWER(t.ZTITLE) = LOWER(?)
        AND n.ZTRASHED = 0
        AND n.ZARCHIVED = 0
      ORDER BY n.ZMODIFICATIONDATE DESC
      LIMIT 100
    `;

    const rows = db.prepare(query).all(tag) as Note[];
    const tagsByNote = getNoteTagsBatch(rows.map(n => n.id));

    return rows.map(note => ({
      ...note,
      tags: tagsByNote[note.id] ?? []
    }));
  } catch (error) {
    logger.error("Failed to list notes by tag", { tag, error });
    throw new DatabaseError("Failed to list notes by tag", error);
  }
};

export const getAllTags = (): Tag[] => {
  const db = getDatabase();

  try {
    const query = `
      SELECT
        t.ZTITLE as name,
        COUNT(DISTINCT CASE WHEN n.ZTRASHED = 0 AND n.ZARCHIVED = 0 THEN n.Z_PK END) as noteCount
      FROM ZSFNOTETAG t
      LEFT JOIN Z_5TAGS nt ON t.Z_PK = nt.Z_13TAGS
      LEFT JOIN ZSFNOTE n ON nt.Z_5NOTES = n.Z_PK
      GROUP BY t.ZTITLE
      HAVING noteCount > 0
      ORDER BY t.ZTITLE
    `;

    return db.prepare(query).all() as Tag[];
  } catch (error) {
    logger.error("Failed to get tags", { error });
    throw new DatabaseError("Failed to get tags", error);
  }
};

export const listArchivedNotes = (): Note[] => {
  const db = getDatabase();

  try {
    const query = `
      SELECT
        ZUNIQUEIDENTIFIER as id,
        ZTITLE as title,
        datetime(ZCREATIONDATE + 978307200, 'unixepoch') as createdAt,
        datetime(ZMODIFICATIONDATE + 978307200, 'unixepoch') as modifiedAt
      FROM ZSFNOTE
      WHERE ZARCHIVED = 1
        AND ZTRASHED = 0
      ORDER BY ZMODIFICATIONDATE DESC
      LIMIT 100
    `;

    const rows = db.prepare(query).all() as Note[];
    const tagsByNote = getNoteTagsBatch(rows.map(n => n.id));

    return rows.map(note => ({
      ...note,
      tags: tagsByNote[note.id] ?? []
    }));
  } catch (error) {
    logger.error("Failed to list archived notes", { error });
    throw new DatabaseError("Failed to list archived notes", error);
  }
};
