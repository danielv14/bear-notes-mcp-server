import type { Note } from "./bear.js";

// Facts about Bear's Core Data store that every read query needs. Defined
// once here so a schema change is a one-line edit, not a five-place hunt.
// The exact column lists and joins stay with each reader (they legitimately
// differ); only these shared fragments live here.

// Core Data stores timestamps as seconds since 2001-01-01; Unix epoch is
// 1970-01-01. This is the offset between them.
export const CORE_DATA_EPOCH_OFFSET = 978307200;

const prefix = (alias: string): string => (alias ? `${alias}.` : "");

// createdAt / modifiedAt projection, converting Core Data timestamps to
// ISO-8601 UTC. `alias` is the table alias used in joined queries.
//
// The trailing Z is not decoration: SQLite's datetime() renders UTC as
// "2021-01-01 00:00:00", which any reader (including an LLM) takes for local
// wall-clock time. In CET that misreports a note written at 01:30 as 23:30 the
// previous day, which shifts the date and not just the hour.
export const timestampColumns = (alias = ""): string => {
  const column = prefix(alias);
  return `strftime('%Y-%m-%dT%H:%M:%SZ', ${column}ZCREATIONDATE + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') as createdAt,
        strftime('%Y-%m-%dT%H:%M:%SZ', ${column}ZMODIFICATIONDATE + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') as modifiedAt`;
};

// The "live notes" filter: not trashed and not archived. The view almost
// every reader wants.
//
// `IS NOT 1` rather than `= 0`, because SQL's `NULL = 0` is NULL, not true: a
// row with an unset flag would fail the predicate and vanish from search, tag
// listings, tag counts and the archive listing alike. `IS NOT` is SQLite's
// NULL-safe comparison, and it also treats any unexpected non-0/1 value as
// live, which is the defensive reading of "not trashed".
export const liveNotesFilter = (alias = ""): string => {
  const column = prefix(alias);
  return `${column}ZTRASHED IS NOT 1 AND ${column}ZARCHIVED IS NOT 1`;
};

// A raw row as returned by the read queries, before normalization. Same shape
// as a Note minus the things that are attached/normalized later: tags are
// joined in separately, SQLite returns the flags as 0/1 rather than booleans,
// and any column can come back NULL.
export type NoteRow = Omit<Note, "tags" | "isTrashed" | "isArchived" | "id" | "title"> & {
  id?: string | null;
  title?: string | null;
  isTrashed?: number | boolean | null;
  isArchived?: number | boolean | null;
};

// Maps a raw query row to a Note, applying the shared normalization rules:
// SQLite returns the flags as 0/1, and tags are attached separately.
//
// A note with no title is legal in Bear, so ZTITLE can be NULL. `Note.title`
// is declared `string`, so the NULL is coerced to "" rather than assigned
// through -- returning `title: null` from a field typed `string` breaks any
// consumer that calls a string method on it, with no compiler warning.
export const toNote = (row: NoteRow, tags: string[] = []): Note => {
  const note: Note = {
    id: row.id ?? "",
    title: row.title ?? "",
    tags,
  };
  // `!= null` rather than `!== undefined`: SQLite returns absent/NULL columns
  // as JS null, and these fields are typed `... | undefined`, so a NULL must be
  // omitted, not assigned through as null.
  if (row.content != null) note.content = row.content;
  if (row.createdAt != null) note.createdAt = row.createdAt;
  if (row.modifiedAt != null) note.modifiedAt = row.modifiedAt;
  if (row.isTrashed != null) note.isTrashed = Boolean(row.isTrashed);
  if (row.isArchived != null) note.isArchived = Boolean(row.isArchived);
  return note;
};

// A note row with no ZUNIQUEIDENTIFIER cannot be used as a handle for any
// follow-up tool call, so it is dropped from list results rather than handed
// out as an id of "".
export const hasUsableId = (row: NoteRow): boolean => row.id != null && row.id !== "";
