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

const ids = (page: { notes: { id: string }[] }) => page.notes.map(note => note.id);

describe("searchNotes", () => {
  test("recent notes excludes trashed and archived", () => {
    expect(ids(searchNotes({}, db))).toEqual(["NOTE-A"]);
  });

  test("converts Core Data timestamps and attaches tags, without leaking content", () => {
    const [note] = searchNotes({}, db).notes;
    expect(note.createdAt).toBe(READABLE_2021);
    expect(note.modifiedAt).toBe(READABLE_2021);
    expect(note.tags).toEqual(["work"]);
    expect("content" in note).toBe(false);
  });

  test("live-note results carry no status flags, since both are false by construction", () => {
    const [note] = searchNotes({}, db).notes;
    expect("isTrashed" in note).toBe(false);
    expect("isArchived" in note).toBe(false);
  });

  test("text search matches title or body but still respects the live filter", () => {
    expect(ids(searchNotes({ term: "alpha" }, db))).toEqual(["NOTE-A"]);
    // "Beta" matches a trashed note's title, so it must be filtered out.
    expect(ids(searchNotes({ term: "Beta" }, db))).toEqual([]);
  });

  test("tag search returns matching live notes", () => {
    expect(ids(searchNotes({ tag: "work" }, db))).toEqual(["NOTE-A"]);
  });

  test("reports the page shape so a count is never mistaken for a total", () => {
    const page = searchNotes({}, db);
    expect(page.count).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(0);
    expect(page.limit).toBeGreaterThan(0);
  });
});

describe("getNoteContent", () => {
  test("returns full content and tags for a note", () => {
    const note = getNoteContent("NOTE-A", db);
    expect(note?.content).toBe("alpha body");
    expect(note?.tags).toEqual(["work"]);
    expect(note?.isTrashed).toBe(false);
    expect(note?.isArchived).toBe(false);
  });

  test("can fetch a trashed note by id (no live filter on lookup)", () => {
    const note = getNoteContent("NOTE-B", db);
    expect(note?.id).toBe("NOTE-B");
    expect(note?.isTrashed).toBe(true);
  });

  test("says when a note is archived, so it is distinguishable from a live one", () => {
    const note = getNoteContent("NOTE-C", db);
    expect(note?.id).toBe("NOTE-C");
    expect(note?.isArchived).toBe(true);
    expect(note?.isTrashed).toBe(false);
  });

  test("returns null for an unknown id", () => {
    expect(getNoteContent("MISSING", db)).toBeNull();
  });
});

describe("listNotesByTag", () => {
  test("matches the tag case-insensitively and respects the live filter", () => {
    expect(ids(listNotesByTag("work", {}, db))).toEqual(["NOTE-A"]);
    expect(ids(listNotesByTag("WORK", {}, db))).toEqual(["NOTE-A"]);
  });
});

describe("getAllTags", () => {
  test("counts only live notes per tag", () => {
    expect(getAllTags(db)).toEqual([{ name: "work", noteCount: 1 }]);
  });
});

describe("listArchivedNotes", () => {
  test("returns archived but not trashed notes, flagged as archived", () => {
    const page = listArchivedNotes({}, db);
    expect(ids(page)).toEqual(["NOTE-C"]);
    expect(page.notes[0].isArchived).toBe(true);
  });
});

describe("NULL columns", () => {
  const nullDb = (): Database => {
    const fixture = new Database(":memory:");
    createBearTables(fixture);
    fixture.run(
      `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
        (1, 'NOTE-NULL', 'Empty', NULL, ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
        (2, 'NOTE-NULLTITLE', NULL, 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
        (3, 'NOTE-NULLFLAGS', 'Unset flags', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, NULL, NULL),
        (4, NULL, 'No id', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0)`
    );
    fixture.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (10, 'work')`);
    fixture.run(`INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (3, 10)`);
    return fixture;
  };

  test("getNoteContent omits content rather than returning null", () => {
    const note = getNoteContent("NOTE-NULL", nullDb());
    expect(note).not.toBeNull();
    expect(note?.title).toBe("Empty");
    expect("content" in note!).toBe(false);
  });

  test("a NULL title becomes an empty string, never null", () => {
    const note = getNoteContent("NOTE-NULLTITLE", nullDb());
    expect(note?.title).toBe("");
  });

  test("a note with NULL trashed/archived flags stays visible everywhere", () => {
    const fixture = nullDb();
    expect(ids(searchNotes({}, fixture))).toContain("NOTE-NULLFLAGS");
    expect(ids(searchNotes({ term: "Unset" }, fixture))).toContain("NOTE-NULLFLAGS");
    expect(ids(searchNotes({ tag: "work" }, fixture))).toContain("NOTE-NULLFLAGS");
    expect(ids(listNotesByTag("work", {}, fixture))).toContain("NOTE-NULLFLAGS");
    expect(getAllTags(fixture)).toEqual([{ name: "work", noteCount: 1 }]);
  });

  test("a note with NULL flags is not treated as archived", () => {
    expect(ids(listArchivedNotes({}, nullDb()))).toEqual([]);
  });

  test("a note with no id is dropped, since it cannot be used as a handle", () => {
    expect(ids(searchNotes({}, nullDb()))).not.toContain("");
  });
});
