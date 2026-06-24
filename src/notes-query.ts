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
// readable datetimes. `alias` is the table alias used in joined queries.
export const timestampColumns = (alias = ""): string => {
  const column = prefix(alias);
  return `datetime(${column}ZCREATIONDATE + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') as createdAt,
        datetime(${column}ZMODIFICATIONDATE + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') as modifiedAt`;
};

// The "live notes" filter: not trashed and not archived. The view almost
// every reader wants.
export const liveNotesFilter = (alias = ""): string => {
  const column = prefix(alias);
  return `${column}ZTRASHED = 0 AND ${column}ZARCHIVED = 0`;
};

// A raw row as returned by the read queries, before normalization. Same shape
// as a Note minus the things that are attached/normalized later: tags are
// joined in separately, and SQLite returns isTrashed as 0/1 rather than a bool.
export type NoteRow = Omit<Note, "tags" | "isTrashed"> & {
  isTrashed?: number | boolean;
};

// Maps a raw query row to a Note, applying the shared normalization rules:
// SQLite returns isTrashed as 0/1, and tags are attached separately.
export const toNote = (row: NoteRow, tags: string[] = []): Note => {
  const note: Note = {
    id: row.id,
    title: row.title,
    tags,
  };
  // `!= null` rather than `!== undefined`: SQLite returns absent/NULL columns
  // as JS null, and content/createdAt/modifiedAt are typed string | undefined,
  // so a NULL must be omitted, not assigned through as null.
  if (row.content != null) note.content = row.content;
  if (row.createdAt != null) note.createdAt = row.createdAt;
  if (row.modifiedAt != null) note.modifiedAt = row.modifiedAt;
  if (row.isTrashed != null) note.isTrashed = Boolean(row.isTrashed);
  return note;
};
