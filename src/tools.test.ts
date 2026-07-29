import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBearServer, toToolResult, handleError } from "./tools";
import { setBearUrlRunner, resetBearUrlRunner, MAX_LIMIT } from "./bear";
import { createBearTables, CORE_DATA_2021 } from "./bear-fixture";

// These tests cross the same seam the MCP client crosses: tools are invoked
// through a connected client over an in-memory transport, so the zod schemas,
// the registration loop's error wrapping, and the result shaping are all in
// the loop -- none of that is reachable by calling bear.ts directly.

const buildFixture = (): Database => {
  const db = new Database(":memory:");
  createBearTables(db);

  db.run(
    `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
      (1, 'NOTE-A', 'Alpha', 'alpha body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (2, 'NOTE-B', 'Gamma archived', 'gamma body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 1)`
  );
  db.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (10, 'work')`);
  db.run(`INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (1, 10)`);

  return db;
};

let db: Database;
let client: Client;

beforeAll(async () => {
  db = buildFixture();
  const server = createBearServer(() => db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "tools-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

// callTool's return type is a union that includes a legacy toolResult shape,
// so the content array is narrowed here once instead of in every test.
const textOf = (result: Awaited<ReturnType<typeof call>>): string =>
  (result as { content: Array<{ text: string }> }).content[0].text;

describe("tool registration", () => {
  test("registers every Bear tool under its documented name", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      "bear_append",
      "bear_archive_note",
      "bear_create_note",
      "bear_delete_tag",
      "bear_get_note",
      "bear_list_archived",
      "bear_list_by_tag",
      "bear_list_tags",
      "bear_prepend",
      "bear_rename_tag",
      "bear_replace_content",
      "bear_search",
      "bear_trash_note",
    ]);
  });
});

describe("read tools against the fixture database", () => {
  test("bear_search returns a page as pretty JSON", async () => {
    const result = await call("bear_search", {});
    const page = JSON.parse(textOf(result));
    expect(page.notes.map((note: { id: string }) => note.id)).toEqual(["NOTE-A"]);
    expect(page.count).toBe(1);
  });

  test("bear_get_note returns the note", async () => {
    const result = await call("bear_get_note", { noteId: "NOTE-A" });
    const note = JSON.parse(textOf(result));
    expect(note.title).toBe("Alpha");
    expect(note.content).toBe("alpha body");
  });

  test("bear_get_note turns an unknown id into an error result, not an empty success", async () => {
    const result = await call("bear_get_note", { noteId: "NOPE" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error: Note not found: NOPE");
  });

  test("bear_list_by_tag echoes the tag alongside the page", async () => {
    const result = await call("bear_list_by_tag", { tag: "work" });
    const page = JSON.parse(textOf(result));
    expect(page.tag).toBe("work");
    expect(page.notes.map((note: { id: string }) => note.id)).toEqual(["NOTE-A"]);
  });

  test("bear_list_tags returns folded tags with counts", async () => {
    const result = await call("bear_list_tags", {});
    expect(JSON.parse(textOf(result))).toEqual([{ name: "work", noteCount: 1 }]);
  });

  test("bear_list_archived returns only archived notes", async () => {
    const result = await call("bear_list_archived", {});
    const page = JSON.parse(textOf(result));
    expect(page.notes.map((note: { id: string }) => note.id)).toEqual(["NOTE-B"]);
  });
});

// The SDK turns an input-validation failure into an isError tool result
// rather than a protocol error, so these calls resolve.
describe("schema validation at the tool surface", () => {
  test("a blank tag is rejected before the handler runs", async () => {
    const result = await call("bear_list_by_tag", { tag: "   " });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Tag must not be blank/);
  });

  test("a blank note title is rejected before anything is sent to Bear", async () => {
    const result = await call("bear_create_note", { title: "  ", text: "body" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Note title must not be empty/);
  });

  test("a limit above MAX_LIMIT is rejected, not clamped, at this surface", async () => {
    const result = await call("bear_search", { limit: MAX_LIMIT + 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Invalid arguments for tool bear_search/);
  });
});

describe("write tools and error wrapping", () => {
  afterEach(() => {
    resetBearUrlRunner();
  });

  test("a successful write reports what was sent, not that it was applied", async () => {
    const captured: string[] = [];
    setBearUrlRunner(async (url) => {
      captured.push(url);
      return { ok: true };
    });

    const result = await call("bear_create_note", { title: "My Note", text: "body" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(
      'Sent to Bear: create note "My Note". Bear does not report back, so this is not confirmation that it was applied.'
    );
    expect(captured).toHaveLength(1);
  });

  test("a BearError from the write path becomes an isError result through the registration loop", async () => {
    setBearUrlRunner(async () => ({ ok: false, reason: "simulated failure" }));

    const result = await call("bear_trash_note", { noteId: "NOTE-A" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error: Failed to call Bear action: trash (simulated failure)");
  });
});

// Unit coverage for the two shaping helpers, ported from the former
// tool-result.ts module. The non-Error branch of handleError has no natural
// path through the tool surface, so it keeps a direct test.
describe("result shaping helpers", () => {
  test("toToolResult passes a string through untouched", () => {
    expect(toToolResult("plain message")).toEqual({
      content: [{ type: "text", text: "plain message" }],
    });
  });

  test("toToolResult serializes an object as pretty JSON", () => {
    expect(toToolResult({ a: 1 })).toEqual({
      content: [{ type: "text", text: '{\n  "a": 1\n}' }],
    });
  });

  test("handleError uses the Error message", () => {
    expect(handleError(new Error("boom"))).toEqual({
      content: [{ type: "text", text: "Error: boom" }],
      isError: true,
    });
  });

  test("handleError falls back for non-Error throwables", () => {
    expect(handleError("boom")).toEqual({
      content: [{ type: "text", text: "Error: An unknown error occurred" }],
      isError: true,
    });
  });
});
