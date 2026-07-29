import { Database } from "bun:sqlite";
import { CORE_DATA_EPOCH_OFFSET } from "./notes-query";

// Test-only helpers for building an in-memory stand-in for Bear's database.
// Imported by the read/search tests; not part of the server bundle.

// 2021-01-01 00:00:00 UTC expressed as a Core Data timestamp (unix 1609459200
// minus the epoch offset, imported so the fixture cannot drift from the
// conversion the queries apply). Reading it back through the queries yields
// the ISO-8601 string below.
export const CORE_DATA_2021 = 1609459200 - CORE_DATA_EPOCH_OFFSET;
export const READABLE_2021 = "2021-01-01T00:00:00Z";

// Core Data's generated entity ids for Bear's note and tag entities, which is
// where the "5" and "13" in Z_5TAGS(Z_5NOTES, Z_13TAGS) come from. The server
// reads them out of Z_PRIMARYKEY instead of hardcoding them, so the fixture
// provides that table too -- and lets a test renumber them.
export const NOTE_ENTITY = 5;
export const TAG_ENTITY = 13;

export interface FixtureSchema {
  noteEntity?: number;
  tagEntity?: number;
  // Skips creating the note/tag join table, to exercise the schema diagnostic.
  omitTagJoinTable?: boolean;
}

// Creates the subset of Bear's schema the read queries touch.
export const createBearTables = (db: Database, schema: FixtureSchema = {}): void => {
  const noteEntity = schema.noteEntity ?? NOTE_ENTITY;
  const tagEntity = schema.tagEntity ?? TAG_ENTITY;

  db.run(`CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT, Z_SUPER INTEGER, Z_MAX INTEGER)`);
  db.run(
    `INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES
      (${noteEntity}, 'SFNote', 0, 0),
      (${tagEntity}, 'SFNoteTag', 0, 0)`
  );

  db.run(`CREATE TABLE ZSFNOTE (
    Z_PK INTEGER PRIMARY KEY,
    ZUNIQUEIDENTIFIER TEXT,
    ZTITLE TEXT,
    ZTEXT TEXT,
    ZCREATIONDATE REAL,
    ZMODIFICATIONDATE REAL,
    ZTRASHED INTEGER,
    ZARCHIVED INTEGER
  )`);
  db.run(`CREATE TABLE ZSFNOTETAG (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT)`);

  if (!schema.omitTagJoinTable) {
    // Core Data names a many-to-many table after the side with the lower
    // entity id, so the table is Z_5TAGS today and would be Z_<tag>NOTES if
    // the numbering were reversed. The columns are named per side either way.
    const table = noteEntity < tagEntity ? `Z_${noteEntity}TAGS` : `Z_${tagEntity}NOTES`;
    db.run(`CREATE TABLE ${table} (Z_${noteEntity}NOTES INTEGER, Z_${tagEntity}TAGS INTEGER)`);
  }
};
