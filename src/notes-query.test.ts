import { test, expect, describe } from "bun:test";
import {
  CORE_DATA_EPOCH_OFFSET,
  timestampColumns,
  liveNotesFilter,
  toNote,
  escapeLike,
} from "./notes-query";

describe("query fragments", () => {
  test("the Core Data epoch offset is the seconds between 2001 and 1970", () => {
    expect(CORE_DATA_EPOCH_OFFSET).toBe(978307200);
  });

  test("timestampColumns converts both timestamps using the offset", () => {
    const sql = timestampColumns();
    expect(sql).toContain("ZCREATIONDATE + 978307200");
    expect(sql).toContain("ZMODIFICATIONDATE + 978307200");
    expect(sql).toContain("as createdAt");
    expect(sql).toContain("as modifiedAt");
  });

  test("timestampColumns prefixes columns with the table alias when given", () => {
    expect(timestampColumns("n")).toContain("n.ZCREATIONDATE");
    expect(timestampColumns()).not.toContain("n.ZCREATIONDATE");
  });

  test("liveNotesFilter excludes trashed and archived notes", () => {
    expect(liveNotesFilter()).toBe("ZTRASHED = 0 AND ZARCHIVED = 0");
    expect(liveNotesFilter("n")).toBe("n.ZTRASHED = 0 AND n.ZARCHIVED = 0");
  });
});

describe("toNote", () => {
  test("normalizes isTrashed from 0/1 to a boolean", () => {
    expect(toNote({ id: "1", title: "A", isTrashed: 1 }).isTrashed).toBe(true);
    expect(toNote({ id: "1", title: "A", isTrashed: 0 }).isTrashed).toBe(false);
  });

  test("omits optional fields that are not present on the row", () => {
    const note = toNote({ id: "1", title: "A" });
    expect(note).toEqual({ id: "1", title: "A", tags: [] });
    expect("content" in note).toBe(false);
    expect("isTrashed" in note).toBe(false);
  });

  test("attaches the supplied tags", () => {
    expect(toNote({ id: "1", title: "A" }, ["work"]).tags).toEqual(["work"]);
  });
});

describe("escapeLike", () => {
  test("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
  });

  test("escapes the escape character itself", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeLike("hello world")).toBe("hello world");
  });
});
