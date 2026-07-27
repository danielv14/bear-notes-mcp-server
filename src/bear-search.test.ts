import { test, expect, describe, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { searchNotes, listNotesByTag, DEFAULT_BROWSE_LIMIT } from "./bear";
import { createBearTables, CORE_DATA_2021 } from "./bear-fixture";

const buildFixture = (): Database => {
  const db = new Database(":memory:");
  createBearTables(db);

  // Notes chosen to expose wildcard, exact-tag, intersection, blank-input and
  // non-ASCII case behavior. S-5000 / S-FILEXNAME are decoys that a wildcard
  // would wrongly match; S-WORK / S-HOMEWORK share body text but differ by
  // tag; S-SV carries Swedish text and a Swedish tag.
  db.run(
    `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
      (1, 'S-DISCOUNT',   'Discount 50% off', 'save now',      ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (2, 'S-5000',       '5000 widgets',     'bulk',          ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (3, 'S-UNDERSCORE', 'file_name',        'doc',           ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (4, 'S-FILEXNAME',  'filexname',        'doc',           ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (5, 'S-WORK',       'work note',        'alpha content', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (6, 'S-HOMEWORK',   'homework note',    'alpha content', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (7, 'S-SV',         'Åtgärder',         'nästa möte',    ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0)`
  );
  db.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (21, 'work'), (22, 'homework'), (23, 'möte')`);
  db.run(`INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (5, 21), (6, 22), (7, 23)`);

  return db;
};

let db: Database;
beforeAll(() => {
  db = buildFixture();
});

const ids = (page: { notes: { id: string }[] }) => page.notes.map(note => note.id).sort();

describe("wildcards in the term match literally", () => {
  test("'50%' finds the literal percent, not everything starting with 50", () => {
    const found = ids(searchNotes({ term: "50%" }, db));
    expect(found).toContain("S-DISCOUNT");
    expect(found).not.toContain("S-5000");
  });

  test("'file_name' treats the underscore literally, not as a single-char wildcard", () => {
    const found = ids(searchNotes({ term: "file_name" }, db));
    expect(found).toContain("S-UNDERSCORE");
    expect(found).not.toContain("S-FILEXNAME");
  });
});

describe("tag search is an exact match, consistent with listNotesByTag", () => {
  test("tag 'work' does not also match 'homework'", () => {
    expect(ids(searchNotes({ tag: "work" }, db))).toEqual(["S-WORK"]);
  });

  test("bear_search and listNotesByTag return identical notes, not just identical ids", () => {
    expect(searchNotes({ tag: "work" }, db)).toEqual(listNotesByTag("work", {}, db));
  });
});

describe("term and tag intersect", () => {
  test("only notes matching both the text and the tag are returned", () => {
    // Both S-WORK and S-HOMEWORK contain 'alpha', but only S-WORK is tagged work.
    expect(ids(searchNotes({ term: "alpha", tag: "work" }, db))).toEqual(["S-WORK"]);
  });

  test("a tag with a non-matching term yields nothing", () => {
    expect(ids(searchNotes({ term: "nonexistent", tag: "work" }, db))).toEqual([]);
  });
});

describe("blank inputs mean 'no filter', the same way for term and tag", () => {
  test("empty term with no tag returns recent notes, not an everything-match artifact", () => {
    expect(searchNotes({ term: "" }, db).count).toBe(7);
  });

  test("whitespace term with a tag falls back to the tag filter", () => {
    expect(ids(searchNotes({ term: "   ", tag: "work" }, db))).toEqual(["S-WORK"]);
  });

  test("a blank or '#'-only tag is no tag filter, matching the blank-term rule", () => {
    expect(searchNotes({ tag: "" }, db).count).toBe(7);
    expect(searchNotes({ tag: "   " }, db).count).toBe(7);
    expect(searchNotes({ tag: "#" }, db).count).toBe(7);
  });

  test("listNotesByTag rejects a blank tag rather than answering 'no notes'", () => {
    expect(() => listNotesByTag("", {}, db)).toThrow(/tag name is required/i);
    expect(() => listNotesByTag("   ", {}, db)).toThrow(/tag name is required/i);
    expect(() => listNotesByTag("#", {}, db)).toThrow(/tag name is required/i);
  });
});

describe("a leading # on a tag is stripped, since Bear stores tags without it", () => {
  test("bear_search accepts '#work'", () => {
    expect(ids(searchNotes({ tag: "#work" }, db))).toEqual(["S-WORK"]);
  });

  test("listNotesByTag accepts '#work'", () => {
    expect(ids(listNotesByTag("#work", {}, db))).toEqual(["S-WORK"]);
  });
});

describe("case-insensitive matching covers non-ASCII characters", () => {
  test("a text search folds å/ä/ö in either direction", () => {
    expect(ids(searchNotes({ term: "åtgärder" }, db))).toEqual(["S-SV"]);
    expect(ids(searchNotes({ term: "MÖTE" }, db))).toEqual(["S-SV"]);
    expect(ids(searchNotes({ term: "Möte" }, db))).toEqual(["S-SV"]);
  });

  test("ASCII case-insensitivity still works", () => {
    expect(ids(searchNotes({ term: "DISCOUNT" }, db))).toEqual(["S-DISCOUNT"]);
  });

  test("tag matching folds non-ASCII in both tag code paths", () => {
    expect(ids(searchNotes({ tag: "MÖTE" }, db))).toEqual(["S-SV"]);
    expect(ids(listNotesByTag("MÖTE", {}, db))).toEqual(["S-SV"]);
  });

  test("a decomposed umlaut matches a precomposed one (NFC normalization)", () => {
    // "mo" + U+0308 combining diaeresis + "te" is a different JS string than
    // the precomposed tag the fixture stores, until both are normalized.
    const decomposed = "mo\u0308te";
    expect(decomposed).not.toBe("m\u00f6te");
    expect(ids(searchNotes({ tag: decomposed }, db))).toEqual(["S-SV"]);
    expect(ids(searchNotes({ term: decomposed }, db))).toEqual(["S-SV"]);
  });
});

describe("paging", () => {
  test("a page smaller than the result set says there is more", () => {
    const page = searchNotes({ limit: 2 }, db);
    expect(page.count).toBe(2);
    expect(page.limit).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  test("the last page says there is no more", () => {
    const page = searchNotes({ limit: 2, offset: 5 }, db);
    expect(page.count).toBe(2);
    expect(page.offset).toBe(5);
    expect(page.hasMore).toBe(false);
  });

  test("offset walks past earlier matches without repeating them", () => {
    const first = searchNotes({ limit: 3 }, db).notes.map(note => note.id);
    const second = searchNotes({ limit: 3, offset: 3 }, db).notes.map(note => note.id);
    expect(first).toHaveLength(3);
    expect(second.some(id => first.includes(id))).toBe(false);
  });

  test("paging applies to a filtered search too", () => {
    const page = searchNotes({ term: "doc", limit: 1 }, db);
    expect(page.count).toBe(1);
    expect(page.hasMore).toBe(true);
  });

  test("the browse view keeps its own smaller default page size", () => {
    expect(searchNotes({}, db).limit).toBe(DEFAULT_BROWSE_LIMIT);
  });
});
