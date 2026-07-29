import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CORE_DATA_EPOCH_OFFSET,
  timestampColumns,
  liveNotesFilter,
  toNote,
  addressableFilter,
} from "./notes-query";

// The fragments are SQL, so they are tested as SQL: each one runs against an
// in-memory table and is judged by the rows it keeps or the values it
// produces, never by its exact spelling -- a semantically identical rewrite
// must stay green. The composed read functions cover the same rules end to
// end in bear-read.test.ts; these pin each fragment in isolation.
const fragmentDb = (): Database => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE ZSFNOTE (
    ZUNIQUEIDENTIFIER TEXT,
    ZCREATIONDATE REAL,
    ZMODIFICATIONDATE REAL,
    ZTRASHED INTEGER,
    ZARCHIVED INTEGER
  )`);
  return db;
};

// 2021-01-01T00:00:00Z in Bear's 2001-based epoch. Independently derived
// (unix 1609459200 minus the 2001 offset), deliberately NOT computed from
// CORE_DATA_EPOCH_OFFSET: subtracting the export here would cancel the offset
// out of the assertion and let any value of it pass.
const RAW_2021 = 631152000;

describe("query fragments", () => {
  test("the Core Data epoch offset is the seconds between 2001 and 1970", () => {
    expect(CORE_DATA_EPOCH_OFFSET).toBe(978307200);
  });

  test("timestampColumns renders Core Data timestamps as ISO-8601 UTC", () => {
    const db = fragmentDb();
    db.run(
      `INSERT INTO ZSFNOTE (ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE) VALUES ('A', ${RAW_2021}, ${RAW_2021})`
    );
    const row = db
      .prepare(`SELECT ${timestampColumns()} FROM ZSFNOTE`)
      .get() as { createdAt: string; modifiedAt: string };
    expect(row.createdAt).toBe("2021-01-01T00:00:00Z");
    expect(row.modifiedAt).toBe("2021-01-01T00:00:00Z");
  });

  test("timestampColumns works against an aliased table", () => {
    const db = fragmentDb();
    db.run(
      `INSERT INTO ZSFNOTE (ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE) VALUES ('A', ${RAW_2021}, ${RAW_2021})`
    );
    const row = db
      .prepare(`SELECT ${timestampColumns("n")} FROM ZSFNOTE n`)
      .get() as { createdAt: string };
    expect(row.createdAt).toBe("2021-01-01T00:00:00Z");
  });

  test("liveNotesFilter keeps live notes and notes with NULL flags, drops trashed and archived", () => {
    const db = fragmentDb();
    db.run(`INSERT INTO ZSFNOTE (ZUNIQUEIDENTIFIER, ZTRASHED, ZARCHIVED) VALUES
      ('live', 0, 0),
      ('null-flags', NULL, NULL),
      ('trashed', 1, 0),
      ('archived', 0, 1)`);
    const pick = (where: string, from = "ZSFNOTE") =>
      (db.prepare(`SELECT ZUNIQUEIDENTIFIER as id FROM ${from} WHERE ${where} ORDER BY id`).all() as {
        id: string;
      }[]).map(row => row.id);

    // The NULL-flag row staying visible is the point of IS NOT 1 over = 0.
    expect(pick(liveNotesFilter())).toEqual(["live", "null-flags"]);
    expect(pick(liveNotesFilter("n"), "ZSFNOTE n")).toEqual(["live", "null-flags"]);
  });
});

describe("toNote", () => {
  test("normalizes the status flags from 0/1 to booleans", () => {
    expect(toNote({ id: "1", title: "A", isTrashed: 1 }).isTrashed).toBe(true);
    expect(toNote({ id: "1", title: "A", isTrashed: 0 }).isTrashed).toBe(false);
    expect(toNote({ id: "1", title: "A", isArchived: 1 }).isArchived).toBe(true);
    expect(toNote({ id: "1", title: "A", isArchived: 0 }).isArchived).toBe(false);
  });

  test("omits optional fields that are not present on the row", () => {
    const note = toNote({ id: "1", title: "A" });
    expect(note).toEqual({ id: "1", title: "A", tags: [] });
    expect("content" in note).toBe(false);
    expect("isTrashed" in note).toBe(false);
    expect("isArchived" in note).toBe(false);
  });

  test("a NULL flag is omitted rather than reported as null or false", () => {
    const note = toNote({ id: "1", title: "A", isTrashed: null, isArchived: null });
    expect("isTrashed" in note).toBe(false);
    expect("isArchived" in note).toBe(false);
  });

  test("a NULL title becomes an empty string, so Note.title is always a string", () => {
    expect(toNote({ id: "1", title: null }).title).toBe("");
  });

  test("attaches the supplied tags", () => {
    expect(toNote({ id: "1", title: "A" }, ["work"]).tags).toEqual(["work"]);
  });
});

describe("addressableFilter", () => {
  test("excludes rows that cannot be used as a handle for a follow-up call", () => {
    const db = fragmentDb();
    db.run(`INSERT INTO ZSFNOTE (ZUNIQUEIDENTIFIER) VALUES ('A'), (NULL), ('')`);
    const pick = (where: string, from = "ZSFNOTE") =>
      (db.prepare(`SELECT ZUNIQUEIDENTIFIER as id FROM ${from} WHERE ${where}`).all() as {
        id: string;
      }[]).map(row => row.id);

    expect(pick(addressableFilter())).toEqual(["A"]);
    expect(pick(addressableFilter("n"), "ZSFNOTE n")).toEqual(["A"]);
  });
});
