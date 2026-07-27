import type { Database } from "bun:sqlite";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDatabase, DatabaseError } from "./database.js";
import { renderNoteMarkdown, buildBearUrl, normalizeTagName } from "./note-format.js";
import { tagJoin, joinTagsFromNote } from "./bear-schema.js";
import { containsFolded, equalsFolded, foldForMatch } from "./text-match.js";
import {
  timestampColumns,
  liveNotesFilter,
  addressableFilter,
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
// sending.
//
// The one ceiling that can actually be measured is the argv limit `open`
// inherits: macOS reports ARG_MAX as 1048576 bytes, and execFile was verified
// to pass a single 1000000-character argument. 500000 leaves half of that for
// the environment block and still sits roughly 10x above the largest real note
// observed in a Bear library (33k characters of Markdown, 54k once encoded).
// It is a backstop against a runaway payload, not a claim about what Bear
// accepts -- Bear's own limit, if any, is undocumented and unobservable from
// here.
export const MAX_BEAR_URL_LENGTH = 500_000;

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

// Bear stores tags without the `#`, so a name sent with one matches nothing
// and the action quietly does nothing -- which, writes being unobservable,
// still reports as sent. Normalized here for the same reason the read path
// normalizes: the caller should not have to know Bear's spelling rules.
const requireTagName = (tag: string, action: string): string => {
  const name = normalizeTagName(tag);
  if (!name) {
    throw new BearError(`Bear action '${action}' needs a tag name, but the value was blank.`);
  }
  return name;
};

export const renameTag = async (name: string, newName: string): Promise<void> => {
  await callBear("rename-tag", {
    name: requireTagName(name, "rename-tag"),
    new_name: requireTagName(newName, "rename-tag"),
  });
};

export const deleteTag = async (name: string): Promise<void> => {
  await callBear("delete-tag", { name: requireTagName(name, "delete-tag") });
};

// ============================================================================
// READ OPERATIONS (via SQLite - fast)
// ============================================================================


// Keeps the actionable schema-mismatch diagnostics from bear-schema.ts intact
// instead of burying them under a generic "Failed to search notes".
const readError = (message: string, error: unknown): DatabaseError =>
  error instanceof DatabaseError ? error : new DatabaseError(message, error);

const clampLimit = (limit: number, fallback: number): number =>
  Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit))) : fallback;

const clampOffset = (offset: number): number =>
  Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;

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

  const rows = db.prepare(query).all(...noteIds) as { noteId: string; name: string | null }[];

  const result: Record<string, string[]> = {};
  for (const row of rows) {
    // ZSFNOTETAG.ZTITLE is nullable like every other column here, and Note.tags
    // is declared string[] -- a NULL would violate it just as silently as a
    // NULL title did.
    if (row.name == null) continue;
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

// A note row plus the two columns that exist only to serve the query itself:
// the body, read for text matching but never projected into the returned Note,
// and the raw modification date, used when the ordering happens in JS.
type SearchRow = NoteRow & { matchText?: string | null; sortKey?: number | null };

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
// two cannot drift in either the rows they return or the fields on them. No
// ORDER BY and no LIMIT: each caller below appends the ones it can afford.
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
    "n.ZMODIFICATIONDATE as sortKey",
  ];
  if (withMatchText) columns.push("n.ZTEXT as matchText");

  const filters = [liveNotesFilter("n"), addressableFilter("n")];
  const params: (string | number)[] = [];

  if (tagName) {
    const tagPks = matchingTagPks(db, tagName);
    if (tagPks.length === 0) return null;

    // A semi-join rather than a JOIN, so no DISTINCT is needed. DISTINCT over
    // a projection that includes ZTEXT would make SQLite copy every tagged
    // note's body into a temp b-tree before yielding the first row.
    const join = tagJoin(db);
    const placeholders = tagPks.map(() => "?").join(", ");
    filters.unshift(
      `n.Z_PK IN (SELECT nt.${join.noteColumn} FROM ${join.table} nt ` +
        `WHERE nt.${join.tagColumn} IN (${placeholders}))`
    );
    params.push(...tagPks);
  }

  return {
    sql: `
      SELECT
        ${columns.join(",\n        ")}
      FROM ZSFNOTE n
      WHERE ${filters.join("\n        AND ")}
    `,
    params,
  };
};

const matchesTerm = (row: SearchRow, term: string): boolean =>
  containsFolded(row.title ?? "", term) || containsFolded(row.matchText ?? "", term);

const toPage = (db: Database, rows: NoteRow[], hasMore: boolean, limit: number, offset: number): NotePage => {
  const notes = withTags(db, rows);
  return { notes, count: notes.length, limit, offset, hasMore };
};

// No text filter: SQLite can order and page the rows itself. One extra row is
// fetched so hasMore is known without a second query.
const pageInSql = (db: Database, query: NoteQuery, limit: number, offset: number): NotePage => {
  const sql = `${query.sql}
      ORDER BY n.ZMODIFICATIONDATE DESC
      LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...query.params, limit + 1, offset) as SearchRow[];
  return toPage(db, rows.slice(0, limit), rows.length > limit, limit, offset);
};

// With a text filter, SQLite cannot do the paging: matching is case-folded in
// JS (Bun's SQLite only folds ASCII), so the number of matches is unknown
// until every candidate has been examined.
//
// The scan therefore runs with no ORDER BY. That matters: `ORDER BY ... ` with
// no LIMIT makes SQLite materialize every candidate row -- bodies included --
// into a temp b-tree before yielding the first one. Streaming instead keeps
// one body in memory at a time, the match set holds only the projected fields,
// and the ordering happens over that much smaller set.
const pageInMemory = (
  db: Database,
  query: NoteQuery,
  term: string,
  limit: number,
  offset: number
): NotePage => {
  const statement = db.prepare(query.sql);
  const matches: SearchRow[] = [];

  try {
    for (const row of statement.iterate(...query.params) as IterableIterator<SearchRow>) {
      if (!matchesTerm(row, term)) continue;
      const { matchText, ...withoutBody } = row;
      matches.push(withoutBody);
    }
  } finally {
    statement.finalize();
  }

  matches.sort((left, right) => (right.sortKey ?? 0) - (left.sortKey ?? 0));
  return toPage(db, matches.slice(offset, offset + limit), matches.length > offset + limit, limit, offset);
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
    const limit = clampLimit(
      options.limit ?? (isBrowse ? DEFAULT_BROWSE_LIMIT : DEFAULT_LIMIT),
      isBrowse ? DEFAULT_BROWSE_LIMIT : DEFAULT_LIMIT
    );
    const offset = clampOffset(options.offset ?? 0);

    const query = buildLiveNotesQuery(db, tagName, term !== undefined);
    if (!query) return emptyPage(limit, offset);

    return term
      ? pageInMemory(db, query, term, limit, offset)
      : pageInSql(db, query, limit, offset);
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
      SELECT t.ZTITLE as name, n.Z_PK as notePk
      FROM ZSFNOTETAG t
      JOIN ${join.table} nt ON t.Z_PK = nt.${join.tagColumn}
      JOIN ZSFNOTE n ON nt.${join.noteColumn} = n.Z_PK
      WHERE ${liveNotesFilter("n")}
    `;

    // Grouped in JS rather than with SQL's GROUP BY, which is byte-exact.
    // "Work" and "work" are one tag as far as bear_list_by_tag is concerned,
    // so bear_list_tags must not report them as two rows with split counts.
    // The note primary keys are collected in a Set so a note carrying both
    // spellings is still counted once.
    const groups = new Map<string, { name: string; notes: Set<number> }>();
    for (const row of db.prepare(query).iterate() as IterableIterator<{ name: string | null; notePk: number }>) {
      if (row.name == null) continue;
      const key = foldForMatch(row.name);
      const group = groups.get(key) ?? { name: row.name, notes: new Set<number>() };
      // Lowest spelling wins as the display name, so the output does not
      // depend on which row SQLite happened to return first.
      if (row.name < group.name) group.name = row.name;
      group.notes.add(row.notePk);
      groups.set(key, group);
    }

    return [...groups.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, group]) => ({ name: group.name, noteCount: group.notes.size }));
  } catch (error) {
    throw readError("Failed to get tags", error);
  }
};

export const listArchivedNotes = (
  options: PageOptions = {},
  db: Database = getDatabase()
): NotePage => {
  try {
    const limit = clampLimit(options.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
    const offset = clampOffset(options.offset ?? 0);

    // ZARCHIVED = 1 stays strict -- a NULL flag is genuinely not archived --
    // but the trashed half is NULL-safe, so a note with unset flags shows up
    // in the live views and not here.
    const query = `
      SELECT
        n.ZUNIQUEIDENTIFIER as id,
        n.ZTITLE as title,
        ${timestampColumns("n")},
        n.ZARCHIVED as isArchived
      FROM ZSFNOTE n
      WHERE n.ZARCHIVED = 1
        AND n.ZTRASHED IS NOT 1
        AND ${addressableFilter("n")}
    `;

    return pageInSql(db, { sql: query, params: [] }, limit, offset);
  } catch (error) {
    throw readError("Failed to list archived notes", error);
  }
};
