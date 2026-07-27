import type { Database } from "bun:sqlite";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDatabase, DatabaseError } from "./database.js";
import { renderNoteMarkdown, buildBearUrl, normalizeTagName } from "./note-format.js";
import { tagJoin, joinTagsFromNote } from "./bear-schema.js";
import { containsFolded, equalsFolded } from "./text-match.js";
import {
  timestampColumns,
  liveNotesFilter,
  toNote,
  hasUsableId,
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
  isArchived?: boolean;
}

export interface Tag {
  name: string;
  noteCount: number;
}

// One page of notes. `count` is the size of *this page* and never a total,
// which is why `hasMore` travels with it: a bare count of 100 reads as "there
// are 100 such notes" when it may mean "there are at least 100".
export interface NotePage {
  notes: Note[];
  count: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

export interface SearchOptions extends PageOptions {
  term?: string;
  tag?: string;
}

// Page size when the caller asked a question (a term or a tag).
export const DEFAULT_LIMIT = 100;
// Page size for the "recent notes" browse view, which is a glance at the top
// of the list rather than a query. Deliberately smaller; both defaults are
// overridable per call.
export const DEFAULT_BROWSE_LIMIT = 50;
export const MAX_LIMIT = 500;

export class BearError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BearError";
  }
}

// ============================================================================
// WRITE OPERATIONS (via URL scheme - safe)
// ============================================================================

// What the runner reports back. Bear itself never answers -- see the note on
// callBear -- so `ok: true` means "handed to macOS", not "Bear applied it".
export type BearUrlOutcome = { ok: true } | { ok: false; reason: string };

export type BearUrlRunner = (url: string) => Promise<BearUrlOutcome>;

const openBearUrl: BearUrlRunner = async (url) => {
  try {
    await execFileAsync("open", ["-g", url]);
    return { ok: true };
  } catch {
    // The thrown error embeds the full command line, and therefore the encoded
    // note title, tags and body. It is deliberately dropped rather than
    // attached as a cause.
    return { ok: false, reason: "macOS could not open the bear:// URL - is Bear installed?" };
  }
};

// The seam between the pure URL construction and actually launching Bear.
// Production runs `open`; tests swap in a runner that captures the URL and can
// simulate a failure.
let runBearUrl: BearUrlRunner = openBearUrl;

export const setBearUrlRunner = (runner: BearUrlRunner): void => {
  runBearUrl = runner;
};

export const resetBearUrlRunner = (): void => {
  runBearUrl = openBearUrl;
};

// Bear documents no maximum URL length, and nothing in the path reports a
// truncated request back to us: `open` exits 0 once macOS finds a handler for
// the bear:// scheme. A payload that is too long is therefore not an error,
// it is a silently half-written note -- and under mode=replace_all that means
// a note overwritten with a partial copy. So the guard has to be here, before
// sending. 32000 characters sits far below the ~1 MB argv ceiling `open`
// inherits and far above any ordinary note; raise it if a real note is ever
// rejected.
export const MAX_BEAR_URL_LENGTH = 32_000;

const callBear = async (action: string, params: Record<string, string>): Promise<void> => {
  const url = buildBearUrl(action, params);

  // Measure the *encoded* URL: percent-encoding inflates non-ASCII content up
  // to 3x, so a Swedish note reaches the ceiling three times sooner than its
  // character count suggests.
  if (url.length > MAX_BEAR_URL_LENGTH) {
    throw new BearError(
      `Bear action '${action}' was not sent: the encoded bear:// URL is ${url.length} characters, ` +
        `over the ${MAX_BEAR_URL_LENGTH} character limit. Send the text in smaller pieces ` +
        "(bear_append adds to an existing note one call at a time)."
    );
  }

  let outcome: BearUrlOutcome;
  try {
    outcome = await runBearUrl(url);
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : "the URL runner failed" };
  }

  if (!outcome.ok) {
    // Report the action and the reason, never the URL: the URL embeds the
    // encoded note title, tags, and body, which must not leak into error
    // messages or logs.
    throw new BearError(`Failed to call Bear action: ${action} (${outcome.reason})`);
  }
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

// mode=replace_all replaces the whole note including its title (Bear's
// `replace` is the variant that keeps the title), which is why the title is
// rendered back into the text as an H1.
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

// There is no unarchive action: Bear's x-callback-url API exposes create,
// add-text, add-file, open-note, open-tag, tags, rename-tag, delete-tag,
// trash, archive, untagged, todo, today, locked, search, grab-url and
// change-theme/change-font, and nothing that clears the archived flag. The
// tool that used to send `bear://x-callback-url/unarchive` has been removed
// rather than left reporting a success Bear never delivered; un-archiving is
// done in Bear's own UI.

export const renameTag = async (name: string, newName: string): Promise<void> => {
  await callBear("rename-tag", { name, new_name: newName });
};

export const deleteTag = async (name: string): Promise<void> => {
  await callBear("delete-tag", { name });
};

// ============================================================================
// READ OPERATIONS (via SQLite - fast)
// ============================================================================

// Keeps the actionable schema-mismatch diagnostics from bear-schema.ts intact
// instead of burying them under a generic "Failed to search notes".
const readError = (message: string, error: unknown): DatabaseError =>
  error instanceof DatabaseError ? error : new DatabaseError(message, error);

const clampLimit = (limit: number): number => Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));

const clampOffset = (offset: number): number => Math.max(0, Math.trunc(offset));

const getNoteTagsBatch = (db: Database, noteIds: string[]): Record<string, string[]> => {
  if (noteIds.length === 0) return {};

  const join = tagJoin(db);
  const placeholders = noteIds.map(() => "?").join(", ");

  const query = `
    SELECT n.ZUNIQUEIDENTIFIER as noteId, t.ZTITLE as name
    FROM ZSFNOTE n
    ${joinTagsFromNote(join, "n")}
    JOIN ZSFNOTETAG t ON nt.${join.tagColumn} = t.Z_PK
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
  const tagsByNote = getNoteTagsBatch(db, rows.map(row => row.id as string));
  return rows.map(row => toNote(row, tagsByNote[row.id as string] ?? []));
};

// A note row plus the body column, which is read for text matching but never
// projected into the returned Note -- list results stay title-only.
type SearchRow = NoteRow & { matchText?: string | null };

// Tag names are compared in JS, so a tag lookup starts by resolving the name
// to primary keys. Bear stores a few hundred tags at most, so reading them all
// is cheaper than it looks and avoids SQLite's ASCII-only LOWER().
const matchingTagPks = (db: Database, tagName: string): number[] => {
  const rows = db
    .prepare("SELECT Z_PK as pk, ZTITLE as name FROM ZSFNOTETAG")
    .all() as { pk: number; name: string | null }[];

  return rows.filter(row => row.name != null && equalsFolded(row.name, tagName)).map(row => row.pk);
};

interface NoteQuery {
  sql: string;
  params: (string | number)[];
}

// The one live-notes query both bear_search and bear_list_by_tag run, so the
// two cannot drift in either the rows they return or the fields on them.
// Returns null when the tag exists in neither spelling nor case, which means
// "no notes" without running a query.
const buildLiveNotesQuery = (
  db: Database,
  tagName: string | undefined,
  withMatchText: boolean
): NoteQuery | null => {
  const columns = [
    "n.ZUNIQUEIDENTIFIER as id",
    "n.ZTITLE as title",
    timestampColumns("n"),
  ];
  if (withMatchText) columns.push("n.ZTEXT as matchText");
  const projection = columns.join(",\n        ");

  if (!tagName) {
    return {
      sql: `
        SELECT
        ${projection}
        FROM ZSFNOTE n
        WHERE ${liveNotesFilter("n")}
        ORDER BY n.ZMODIFICATIONDATE DESC
      `,
      params: [],
    };
  }

  const tagPks = matchingTagPks(db, tagName);
  if (tagPks.length === 0) return null;

  const join = tagJoin(db);
  const placeholders = tagPks.map(() => "?").join(", ");

  return {
    sql: `
      SELECT DISTINCT
      ${projection}
      FROM ZSFNOTE n
      ${joinTagsFromNote(join, "n")}
      WHERE nt.${join.tagColumn} IN (${placeholders})
        AND ${liveNotesFilter("n")}
      ORDER BY n.ZMODIFICATIONDATE DESC
    `,
    params: tagPks,
  };
};

const matchesTerm = (row: SearchRow, term?: string): boolean =>
  !term || containsFolded(row.title ?? "", term) || containsFolded(row.matchText ?? "", term);

// Streams the ordered rows, applies the JS-side text filter, and stops one row
// past the page. Filtering in JS is what makes non-ASCII case-insensitivity
// work at all (SQLite's LIKE/LOWER only fold ASCII), so SQLite can no longer
// apply the LIMIT -- walking the cursor and breaking early keeps that from
// turning into "load the whole database".
const collectPage = (
  db: Database,
  query: NoteQuery,
  term: string | undefined,
  limit: number,
  offset: number
): { rows: SearchRow[]; hasMore: boolean } => {
  const statement = db.prepare(query.sql);
  const rows: SearchRow[] = [];
  let matched = 0;
  let hasMore = false;

  try {
    for (const row of statement.iterate(...query.params) as IterableIterator<SearchRow>) {
      if (!hasUsableId(row) || !matchesTerm(row, term)) continue;
      matched++;
      if (matched <= offset) continue;
      if (rows.length < limit) {
        rows.push(row);
        continue;
      }
      hasMore = true;
      break;
    }
  } finally {
    statement.finalize();
  }

  return { rows, hasMore };
};

const emptyPage = (limit: number, offset: number): NotePage => ({
  notes: [],
  count: 0,
  limit,
  offset,
  hasMore: false,
});

export const searchNotes = (options: SearchOptions = {}, db: Database = getDatabase()): NotePage => {
  try {
    // A blank term means "no text filter", and a blank or "#"-only tag means
    // "no tag filter" -- the same rule for both, so a caller whose variable
    // happens to be empty gets recent notes rather than a silent empty list.
    const term = options.term?.trim() || undefined;
    const tagName = options.tag ? normalizeTagName(options.tag) : undefined;

    const isBrowse = !term && !tagName;
    const limit = clampLimit(options.limit ?? (isBrowse ? DEFAULT_BROWSE_LIMIT : DEFAULT_LIMIT));
    const offset = clampOffset(options.offset ?? 0);

    const query = buildLiveNotesQuery(db, tagName, term !== undefined);
    if (!query) return emptyPage(limit, offset);

    const { rows, hasMore } = collectPage(db, query, term, limit, offset);
    const notes = withTags(db, rows);
    return { notes, count: notes.length, limit, offset, hasMore };
  } catch (error) {
    throw readError("Failed to search notes", error);
  }
};

export const getNoteContent = (noteId: string, db: Database = getDatabase()): Note | null => {
  try {
    // No live filter: looking a note up by id should work for a trashed or
    // archived note, which is exactly why both flags are projected here.
    const query = `
      SELECT
        ZUNIQUEIDENTIFIER as id,
        ZTITLE as title,
        ZTEXT as content,
        ${timestampColumns()},
        ZTRASHED as isTrashed,
        ZARCHIVED as isArchived
      FROM ZSFNOTE
      WHERE ZUNIQUEIDENTIFIER = ?
    `;

    const row = db.prepare(query).get(noteId) as NoteRow | undefined;
    if (!row) return null;

    return toNote(row, getNoteTags(db, noteId));
  } catch (error) {
    throw readError("Failed to get note content", error);
  }
};

export const listNotesByTag = (
  tag: string,
  options: PageOptions = {},
  db: Database = getDatabase()
): NotePage => {
  const tagName = normalizeTagName(tag);
  // Unlike bear_search, this tool has nothing to fall back to: "no tag filter"
  // is not a meaningful answer to "list the notes with this tag", and an empty
  // list would read as "no notes have it".
  if (!tagName) {
    throw new BearError("A tag name is required, but the value was blank.");
  }
  return searchNotes({ tag: tagName, limit: options.limit, offset: options.offset }, db);
};

export const getAllTags = (db: Database = getDatabase()): Tag[] => {
  try {
    const join = tagJoin(db);
    const query = `
      SELECT
        t.ZTITLE as name,
        COUNT(DISTINCT CASE WHEN ${liveNotesFilter("n")} THEN n.Z_PK END) as noteCount
      FROM ZSFNOTETAG t
      LEFT JOIN ${join.table} nt ON t.Z_PK = nt.${join.tagColumn}
      LEFT JOIN ZSFNOTE n ON nt.${join.noteColumn} = n.Z_PK
      GROUP BY t.ZTITLE
      HAVING noteCount > 0
      ORDER BY t.ZTITLE
    `;

    return db.prepare(query).all() as Tag[];
  } catch (error) {
    throw readError("Failed to get tags", error);
  }
};

export const listArchivedNotes = (
  options: PageOptions = {},
  db: Database = getDatabase()
): NotePage => {
  try {
    const limit = clampLimit(options.limit ?? DEFAULT_LIMIT);
    const offset = clampOffset(options.offset ?? 0);

    // ZARCHIVED = 1 stays strict -- a NULL flag is genuinely not archived --
    // but the trashed half is NULL-safe, so a note with unset flags shows up
    // in the live views and not here.
    const query = `
      SELECT
        ZUNIQUEIDENTIFIER as id,
        ZTITLE as title,
        ${timestampColumns()},
        ZARCHIVED as isArchived
      FROM ZSFNOTE
      WHERE ZARCHIVED = 1
        AND ZTRASHED IS NOT 1
      ORDER BY ZMODIFICATIONDATE DESC
    `;

    const { rows, hasMore } = collectPage(db, { sql: query, params: [] }, undefined, limit, offset);
    const notes = withTags(db, rows);
    return { notes, count: notes.length, limit, offset, hasMore };
  } catch (error) {
    throw readError("Failed to list archived notes", error);
  }
};
