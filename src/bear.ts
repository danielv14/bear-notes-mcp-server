import type { Database } from "bun:sqlite";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDatabase, DatabaseError } from "./database.js";
import { renderNoteMarkdown, buildBearUrl } from "./note-format.js";
import {
  timestampColumns,
  liveNotesFilter,
  toNote,
  type NoteRow,
} from "./notes-query.js";

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

export type BearUrlRunner = (url: string) => Promise<void>;

const openBearUrl: BearUrlRunner = async (url) => {
  try {
    await execFileAsync("open", ["-g", url]);
  } catch (error) {
    // The URL carries the action (bear://x-callback-url/<action>?...), so this
    // keeps the per-action diagnosability the previous message had.
    throw new BearError(`Failed to open Bear URL: ${url}`, error);
  }
};

// The seam between the pure URL construction and actually launching Bear.
// Production runs `open`; tests swap in a runner that captures the URL.
let runBearUrl: BearUrlRunner = openBearUrl;

export const setBearUrlRunner = (runner: BearUrlRunner): void => {
  runBearUrl = runner;
};

export const resetBearUrlRunner = (): void => {
  runBearUrl = openBearUrl;
};

const callBear = async (action: string, params: Record<string, string>): Promise<void> => {
  await runBearUrl(buildBearUrl(action, params));
};

export const createNote = async (title: string, text: string, tags?: string[]): Promise<void> => {
  await callBear("create", { text: renderNoteMarkdown({ title, text, tags }) });
};

export const appendToNote = async (noteId: string, text: string): Promise<void> => {
  await callBear("add-text", { id: noteId, text, mode: "append" });
};

export const prependToNote = async (noteId: string, text: string): Promise<void> => {
  await callBear("add-text", { id: noteId, text, mode: "prepend" });
};

export const replaceNoteContent = async (noteId: string, title: string, text: string, tags?: string[]): Promise<void> => {
  await callBear("add-text", {
    id: noteId,
    text: renderNoteMarkdown({ title, text, tags }),
    mode: "replace_all",
  });
};

export const trashNote = async (noteId: string): Promise<void> => {
  await callBear("trash", { id: noteId });
};

export const archiveNote = async (noteId: string): Promise<void> => {
  await callBear("archive", { id: noteId });
};

export const unarchiveNote = async (noteId: string): Promise<void> => {
  await callBear("unarchive", { id: noteId });
};

export const renameTag = async (name: string, newName: string): Promise<void> => {
  await callBear("rename-tag", { name, new_name: newName });
};

export const deleteTag = async (name: string): Promise<void> => {
  await callBear("delete-tag", { name });
};

// ============================================================================
// READ OPERATIONS (via SQLite - fast)
// ============================================================================

const getNoteTagsBatch = (db: Database, noteIds: string[]): Record<string, string[]> => {
  if (noteIds.length === 0) return {};

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

const getNoteTags = (db: Database, noteId: string): string[] =>
  getNoteTagsBatch(db, [noteId])[noteId] ?? [];

// Attaches batched tags to a set of rows and normalizes them to Notes.
const withTags = (db: Database, rows: NoteRow[]): Note[] => {
  const tagsByNote = getNoteTagsBatch(db, rows.map(row => row.id));
  return rows.map(row => toNote(row, tagsByNote[row.id] ?? []));
};

export const searchNotes = (term?: string, tag?: string, db: Database = getDatabase()): Note[] => {
  try {
    let query: string;
    let params: string[];

    if (tag) {
      query = `
        SELECT DISTINCT
          n.ZUNIQUEIDENTIFIER as id,
          n.ZTITLE as title,
          ${timestampColumns("n")},
          n.ZTRASHED as isTrashed
        FROM ZSFNOTE n
        JOIN Z_5TAGS nt ON n.Z_PK = nt.Z_5NOTES
        JOIN ZSFNOTETAG t ON nt.Z_13TAGS = t.Z_PK
        WHERE t.ZTITLE LIKE ?
          AND ${liveNotesFilter("n")}
        ORDER BY n.ZMODIFICATIONDATE DESC
        LIMIT 100
      `;
      params = [`%${tag}%`];
    } else {
      // Text search and "recent notes" differ only by an optional term filter
      // and the row limit, so they share one query.
      const termFilter = term ? `(ZTITLE LIKE ? OR ZTEXT LIKE ?) AND ` : "";
      const limit = term ? 100 : 50;
      query = `
        SELECT
          ZUNIQUEIDENTIFIER as id,
          ZTITLE as title,
          ${timestampColumns()},
          ZTRASHED as isTrashed
        FROM ZSFNOTE
        WHERE ${termFilter}${liveNotesFilter()}
        ORDER BY ZMODIFICATIONDATE DESC
        LIMIT ${limit}
      `;
      params = term ? [`%${term}%`, `%${term}%`] : [];
    }

    const rows = db.prepare(query).all(...params) as NoteRow[];
    return withTags(db, rows);
  } catch (error) {
    throw new DatabaseError("Failed to search notes", error);
  }
};

export const getNoteContent = (noteId: string, db: Database = getDatabase()): Note | null => {
  try {
    const query = `
      SELECT
        ZUNIQUEIDENTIFIER as id,
        ZTITLE as title,
        ZTEXT as content,
        ${timestampColumns()},
        ZTRASHED as isTrashed
      FROM ZSFNOTE
      WHERE ZUNIQUEIDENTIFIER = ?
    `;

    const row = db.prepare(query).get(noteId) as NoteRow | undefined;
    if (!row) return null;

    return toNote(row, getNoteTags(db, noteId));
  } catch (error) {
    throw new DatabaseError("Failed to get note content", error);
  }
};

export const listNotesByTag = (tag: string, db: Database = getDatabase()): Note[] => {
  try {
    const query = `
      SELECT DISTINCT
        n.ZUNIQUEIDENTIFIER as id,
        n.ZTITLE as title,
        ${timestampColumns("n")}
      FROM ZSFNOTE n
      JOIN Z_5TAGS nt ON n.Z_PK = nt.Z_5NOTES
      JOIN ZSFNOTETAG t ON nt.Z_13TAGS = t.Z_PK
      WHERE LOWER(t.ZTITLE) = LOWER(?)
        AND ${liveNotesFilter("n")}
      ORDER BY n.ZMODIFICATIONDATE DESC
      LIMIT 100
    `;

    const rows = db.prepare(query).all(tag) as NoteRow[];
    return withTags(db, rows);
  } catch (error) {
    throw new DatabaseError("Failed to list notes by tag", error);
  }
};

export const getAllTags = (db: Database = getDatabase()): Tag[] => {
  try {
    const query = `
      SELECT
        t.ZTITLE as name,
        COUNT(DISTINCT CASE WHEN ${liveNotesFilter("n")} THEN n.Z_PK END) as noteCount
      FROM ZSFNOTETAG t
      LEFT JOIN Z_5TAGS nt ON t.Z_PK = nt.Z_13TAGS
      LEFT JOIN ZSFNOTE n ON nt.Z_5NOTES = n.Z_PK
      GROUP BY t.ZTITLE
      HAVING noteCount > 0
      ORDER BY t.ZTITLE
    `;

    return db.prepare(query).all() as Tag[];
  } catch (error) {
    throw new DatabaseError("Failed to get tags", error);
  }
};

export const listArchivedNotes = (db: Database = getDatabase()): Note[] => {
  try {
    const query = `
      SELECT
        ZUNIQUEIDENTIFIER as id,
        ZTITLE as title,
        ${timestampColumns()}
      FROM ZSFNOTE
      WHERE ZARCHIVED = 1
        AND ZTRASHED = 0
      ORDER BY ZMODIFICATIONDATE DESC
      LIMIT 100
    `;

    const rows = db.prepare(query).all() as NoteRow[];
    return withTags(db, rows);
  } catch (error) {
    throw new DatabaseError("Failed to list archived notes", error);
  }
};
