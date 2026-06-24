import { test, expect, describe, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { searchNotes, listNotesByTag } from "./bear";
import { createBearTables, CORE_DATA_2021 } from "./bear-fixture";

const buildFixture = (): Database => {
  const db = new Database(":memory:");
  createBearTables(db);

  // Notes chosen to expose wildcard, exact-tag, intersection and blank-term
  // behavior. S-5000 / S-FILEXNAME are decoys that a wildcard would wrongly
  // match; S-WORK / S-HOMEWORK share body text but differ by tag.
  db.run(
    `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
      (1, 'S-DISCOUNT',   'Discount 50% off', 'save now',      ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (2, 'S-5000',       '5000 widgets',     'bulk',          ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (3, 'S-UNDERSCORE', 'file_name',        'doc',           ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (4, 'S-FILEXNAME',  'filexname',        'doc',           ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (5, 'S-WORK',       'work note',        'alpha content', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (6, 'S-HOMEWORK',   'homework note',    'alpha content', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0)`
  );
  db.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (21, 'work'), (22, 'homework')`);
  db.run(`INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (5, 21), (6, 22)`);

  return db;
};

let db: Database;
beforeAll(() => {
  db = buildFixture();
});

const ids = (notes: { id: string }[]) => notes.map(note => note.id).sort();

describe("LIKE wildcards in the term match literally", () => {
  test("'50%' finds the literal percent, not everything starting with 50", () => {
    const found = ids(searchNotes("50%", undefined, db));
    expect(found).toContain("S-DISCOUNT");
    expect(found).not.toContain("S-5000");
  });

  test("'file_name' treats the underscore literally, not as a single-char wildcard", () => {
    const found = ids(searchNotes("file_name", undefined, db));
    expect(found).toContain("S-UNDERSCORE");
    expect(found).not.toContain("S-FILEXNAME");
  });
});

describe("tag search is an exact match, consistent with listNotesByTag", () => {
  test("tag 'work' does not also match 'homework'", () => {
    expect(ids(searchNotes(undefined, "work", db))).toEqual(["S-WORK"]);
  });

  test("bear_search and listNotesByTag return the same notes for a tag", () => {
    expect(ids(searchNotes(undefined, "work", db))).toEqual(ids(listNotesByTag("work", db)));
  });
});

describe("term and tag intersect", () => {
  test("only notes matching both the text and the tag are returned", () => {
    // Both S-WORK and S-HOMEWORK contain 'alpha', but only S-WORK is tagged work.
    expect(ids(searchNotes("alpha", "work", db))).toEqual(["S-WORK"]);
  });

  test("a tag with a non-matching term yields nothing", () => {
    expect(searchNotes("nonexistent", "work", db)).toEqual([]);
  });
});

describe("a blank term is treated as no text filter", () => {
  test("empty term with no tag returns recent notes, not an everything-match artifact", () => {
    expect(searchNotes("", undefined, db)).toHaveLength(6);
  });

  test("whitespace term with a tag falls back to the tag filter", () => {
    expect(ids(searchNotes("   ", "work", db))).toEqual(["S-WORK"]);
  });
});
