import { test, expect, describe, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  searchNotes,
  getNoteContent,
  listNotesByTag,
  getAllTags,
  listArchivedNotes,
} from "./bear";
import { createBearTables, CORE_DATA_2021, READABLE_2021 } from "./bear-fixture";

const buildFixture = (): Database => {
  const db = new Database(":memory:");
  createBearTables(db);

  db.run(
    `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
      (1, 'NOTE-A', 'Alpha', 'alpha body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (2, 'NOTE-B', 'Beta trashed', 'beta body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 1, 0),
      (3, 'NOTE-C', 'Gamma archived', 'gamma body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 1)`
  );
  db.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (10, 'work')`);
  db.run(`INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (1, 10)`);

  return db;
};

let db: Database;
beforeAll(() => {
  db = buildFixture();
});

describe("searchNotes", () => {
  test("recent notes excludes trashed and archived", () => {
    const notes = searchNotes(undefined, undefined, db);
    expect(notes.map(n => n.id)).toEqual(["NOTE-A"]);
  });

  test("converts Core Data timestamps and attaches tags, without leaking content", () => {
    const [note] = searchNotes(undefined, undefined, db);
    expect(note.createdAt).toBe(READABLE_2021);
    expect(note.modifiedAt).toBe(READABLE_2021);
    expect(note.isTrashed).toBe(false);
    expect(note.tags).toEqual(["work"]);
    expect("content" in note).toBe(false);
  });

  test("text search matches title or body but still respects the live filter", () => {
    expect(searchNotes("alpha", undefined, db).map(n => n.id)).toEqual(["NOTE-A"]);
    // "Beta" matches a trashed note's title, so it must be filtered out.
    expect(searchNotes("Beta", undefined, db)).toEqual([]);
  });

  test("tag search returns matching live notes", () => {
    expect(searchNotes(undefined, "work", db).map(n => n.id)).toEqual(["NOTE-A"]);
  });
});

describe("getNoteContent", () => {
  test("returns full content and tags for a note", () => {
    const note = getNoteContent("NOTE-A", db);
    expect(note?.content).toBe("alpha body");
    expect(note?.tags).toEqual(["work"]);
    expect(note?.isTrashed).toBe(false);
  });

  test("can fetch a trashed note by id (no live filter on lookup)", () => {
    const note = getNoteContent("NOTE-B", db);
    expect(note?.id).toBe("NOTE-B");
    expect(note?.isTrashed).toBe(true);
  });

  test("returns null for an unknown id", () => {
    expect(getNoteContent("MISSING", db)).toBeNull();
  });
});

describe("listNotesByTag", () => {
  test("matches the tag case-insensitively and respects the live filter", () => {
    expect(listNotesByTag("work", db).map(n => n.id)).toEqual(["NOTE-A"]);
    expect(listNotesByTag("WORK", db).map(n => n.id)).toEqual(["NOTE-A"]);
  });
});

describe("getAllTags", () => {
  test("counts only live notes per tag", () => {
    expect(getAllTags(db)).toEqual([{ name: "work", noteCount: 1 }]);
  });
});

describe("listArchivedNotes", () => {
  test("returns archived but not trashed notes", () => {
    expect(listArchivedNotes(db).map(n => n.id)).toEqual(["NOTE-C"]);
  });
});

describe("NULL note body", () => {
  test("getNoteContent omits content rather than returning null", () => {
    const nullDb = new Database(":memory:");
    createBearTables(nullDb);
    nullDb.run(
      `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
        (1, 'NOTE-NULL', 'Empty', NULL, ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0)`
    );
    const note = getNoteContent("NOTE-NULL", nullDb);
    expect(note).not.toBeNull();
    expect(note?.title).toBe("Empty");
    expect("content" in note!).toBe(false);
  });
});
