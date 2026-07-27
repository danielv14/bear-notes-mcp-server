import { test, expect, describe } from "bun:test";
import {
  CORE_DATA_EPOCH_OFFSET,
  timestampColumns,
  liveNotesFilter,
  toNote,
  hasUsableId,
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

  test("timestampColumns marks the result as UTC, so it cannot read as local time", () => {
    expect(timestampColumns()).toContain("%Y-%m-%dT%H:%M:%SZ");
  });

  test("timestampColumns prefixes columns with the table alias when given", () => {
    expect(timestampColumns("n")).toContain("n.ZCREATIONDATE");
    expect(timestampColumns()).not.toContain("n.ZCREATIONDATE");
  });

  test("liveNotesFilter excludes trashed and archived notes, NULL-safely", () => {
    expect(liveNotesFilter()).toBe("ZTRASHED IS NOT 1 AND ZARCHIVED IS NOT 1");
    expect(liveNotesFilter("n")).toBe("n.ZTRASHED IS NOT 1 AND n.ZARCHIVED IS NOT 1");
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

describe("hasUsableId", () => {
  test("rejects rows that cannot be used as a handle for a follow-up call", () => {
    expect(hasUsableId({ id: "N-1" })).toBe(true);
    expect(hasUsableId({ id: null })).toBe(false);
    expect(hasUsableId({ id: "" })).toBe(false);
    expect(hasUsableId({})).toBe(false);
  });
});
