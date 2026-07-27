import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { discoverTagJoin } from "./bear-schema";
import { searchNotes, getAllTags } from "./bear";
import { createBearTables, CORE_DATA_2021 } from "./bear-fixture";

const withNote = (db: Database): Database => {
  db.run(
    `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
      (1, 'N-1', 'Alpha', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0)`
  );
  db.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (10, 'work')`);
  return db;
};

describe("discoverTagJoin", () => {
  test("derives the join table from the Core Data entity ids, not from hardcoded names", () => {
    const db = new Database(":memory:");
    createBearTables(db);
    expect(discoverTagJoin(db)).toEqual({
      table: "Z_5TAGS",
      noteColumn: "Z_5NOTES",
      tagColumn: "Z_13TAGS",
    });
  });

  test("follows a renumbered schema instead of breaking on it", () => {
    const db = new Database(":memory:");
    createBearTables(db, { noteEntity: 7, tagEntity: 15 });
    expect(discoverTagJoin(db)).toEqual({
      table: "Z_7TAGS",
      noteColumn: "Z_7NOTES",
      tagColumn: "Z_15TAGS",
    });
  });

  test("names the missing table when the join table is gone", () => {
    const db = new Database(":memory:");
    createBearTables(db, { omitTagJoinTable: true });
    expect(() => discoverTagJoin(db)).toThrow(/Z_5TAGS/);
    expect(() => discoverTagJoin(db)).toThrow(/schema/i);
  });

  test("names the missing entity when Z_PRIMARYKEY has no note/tag entity", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME TEXT, Z_SUPER INTEGER, Z_MAX INTEGER)`);
    expect(() => discoverTagJoin(db)).toThrow(/SFNote/);
  });
});

describe("read queries against a renumbered schema", () => {
  test("tag queries keep working when the entity ids differ", () => {
    const db = withNote((() => {
      const fresh = new Database(":memory:");
      createBearTables(fresh, { noteEntity: 7, tagEntity: 15 });
      return fresh;
    })());
    db.run(`INSERT INTO Z_7TAGS (Z_7NOTES, Z_15TAGS) VALUES (1, 10)`);

    expect(searchNotes({ tag: "work" }, db).notes.map(note => note.id)).toEqual(["N-1"]);
    expect(getAllTags(db)).toEqual([{ name: "work", noteCount: 1 }]);
  });

  test("a missing join table surfaces the schema diagnostic, not 'Failed to search notes'", () => {
    const db = withNote((() => {
      const fresh = new Database(":memory:");
      createBearTables(fresh, { omitTagJoinTable: true });
      return fresh;
    })());

    expect(() => searchNotes({ tag: "work" }, db)).toThrow(/Z_5TAGS/);
    expect(() => searchNotes({ tag: "work" }, db)).not.toThrow(/Failed to search notes/);
  });
});
