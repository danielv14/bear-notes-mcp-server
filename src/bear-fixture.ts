import { Database } from "bun:sqlite";

// Test-only helpers for building an in-memory stand-in for Bear's database.
// Imported by the read/search tests; not part of the server bundle.

// 2021-01-01 00:00:00 UTC expressed as a Core Data timestamp (unix 1609459200
// minus the epoch offset). Reading it back through the queries yields the
// datetime string below.
export const CORE_DATA_2021 = 1609459200 - 978307200;
export const READABLE_2021 = "2021-01-01 00:00:00";

// Creates the subset of Bear's schema the read queries touch.
export const createBearTables = (db: Database): void => {
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
  db.run(`CREATE TABLE Z_5TAGS (Z_5NOTES INTEGER, Z_13TAGS INTEGER)`);
};
