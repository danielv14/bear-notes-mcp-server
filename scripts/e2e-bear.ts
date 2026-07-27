// End-to-end check of the MCP server against a real Bear install.
//
// Spawns src/server.ts as a subprocess and drives it over stdio JSON-RPC, the
// same way Claude Code does, so the run exercises the tool table, the Zod
// schemas, the bear:// URL scheme and the SQLite reads together. Nothing here
// is mocked; see docs/TEST-PROTOCOL.md for what it covers and what it cannot.
//
// It writes to the real Bear library. Everything it creates is named with a
// run-unique stamp and is trashed and untagged before it exits.
//
//   bun run e2e

import { join } from "path";

const SERVER = join(import.meta.dir, "..", "src", "server.ts");

const proc = Bun.spawn(["bun", "run", SERVER], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";
const pending = new Map<number, (message: any) => void>();

const readLoop = async (): Promise<void> => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = message.id != null ? pending.get(message.id) : undefined;
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  }
};
void readLoop();

let nextId = 1;
const request = (method: string, params?: unknown): Promise<any> => {
  const id = nextId++;
  const response = new Promise<any>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000);
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return response;
};

const notify = (method: string, params?: unknown): void => {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
};

interface ToolCall {
  isError: boolean;
  text: string;
  json: any;
}

const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCall> => {
  const response = await request("tools/call", { name, arguments: args });
  if (response.error) return { isError: true, text: JSON.stringify(response.error), json: null };
  const text = response.result?.content?.[0]?.text ?? "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A write tool answers with a plain sentence, not JSON.
  }
  return { isError: response.result?.isError === true, text, json };
};

let passed = 0;
let failed = 0;

const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
    return;
  }
  failed++;
  console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
};

const section = (title: string): void => console.log(`\n${title}`);

// Bear applies writes asynchronously and this server reads SQLite, so a change
// is not visible the instant a write tool returns. Poll for the expected state
// rather than sleeping a fixed amount and hoping.
const eventually = async <T>(what: string, probe: () => Promise<T | null>, ms = 20_000): Promise<T | null> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await Bun.sleep(500);
  }
  console.log(`  (gave up waiting for ${what} after ${ms / 1000}s)`);
  return null;
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).toLowerCase();
const TAG = `mcp-e2e-${stamp}`;
const RENAMED_TAG = `${TAG}-renamed`;
const NESTED_TAG = `${TAG}/nested`;
const MULTIWORD_TAG = `${TAG} med mellanslag`;
const TITLE = `MCP E2E ${stamp}`;
// A token that cannot collide with anything already in the library.
const MARKER = `zqx${stamp.replace(/\D/g, "")}`;

const listTagNames = async (): Promise<string[]> => {
  const tags = await call("bear_list_tags");
  return (tags.json ?? []).map((tag: any) => tag.name);
};

const run = async (): Promise<void> => {
  const initialize = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-bear", version: "1.0.0" },
  });
  notify("notifications/initialized");
  console.log(`server: ${initialize.result.serverInfo.name} ${initialize.result.serverInfo.version}`);

  section("1. Tool surface");
  const tools = await request("tools/list");
  const names: string[] = tools.result.tools.map((tool: any) => tool.name);
  check("13 tools are registered", names.length === 13, `got ${names.length}: ${names.join(", ")}`);
  check("bear_unarchive_note is not offered", !names.includes("bear_unarchive_note"));
  const searchSchema = tools.result.tools.find((tool: any) => tool.name === "bear_search").inputSchema;
  check(
    "bear_search advertises term, tag, limit and offset",
    Object.keys(searchSchema.properties).sort().join(",") === "limit,offset,tag,term"
  );

  section("2. Create a note with plain, nested and multiword tags");
  const created = await call("bear_create_note", {
    title: TITLE,
    text: `Nästa möte om ${MARKER}. Rabatt 50% och file_name här.`,
    tags: [TAG, `#${NESTED_TAG}`, `#${MULTIWORD_TAG}#`],
  });
  check("create is not an error", !created.isError, created.text);
  check("create reports what was sent, not what was applied", created.text.startsWith("Sent to Bear:"), created.text);

  const noteId = await eventually("the new note to reach SQLite", async () => {
    const page = await call("bear_search", { term: MARKER });
    return page.json?.notes?.[0]?.id ?? null;
  });
  check("the note is findable by a term from its body", noteId !== null);
  if (!noteId) return;
  console.log(`  note id: ${noteId}`);

  section("3. Read it back");
  const fetched = await call("bear_get_note", { noteId });
  check("bear_get_note returns it", fetched.json?.id === noteId);
  check("the title round-trips", fetched.json?.title === TITLE, fetched.json?.title);
  check("isTrashed is false", fetched.json?.isTrashed === false);
  check("isArchived is false", fetched.json?.isArchived === false);
  check(
    "timestamps are ISO-8601 UTC",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fetched.json?.modifiedAt ?? ""),
    fetched.json?.modifiedAt
  );
  const tags: string[] = fetched.json?.tags ?? [];
  check("the plain tag is stored without a #", tags.includes(TAG), tags.join(" | "));
  check("the nested tag kept its slash", tags.includes(NESTED_TAG), tags.join(" | "));
  check("the multiword tag is one tag, not two", tags.includes(MULTIWORD_TAG), tags.join(" | "));

  section("4. Search");
  const folded = await call("bear_search", { term: `MÖTE OM ${MARKER.toUpperCase()}` });
  check("non-ASCII case folding finds it", folded.json?.notes?.some((n: any) => n.id === noteId));
  const percent = await call("bear_search", { term: "50%" });
  check("'50%' matches the literal percent", percent.json?.notes?.some((n: any) => n.id === noteId));
  const underscore = await call("bear_search", { term: "file_name" });
  check("'file_name' treats the underscore literally", underscore.json?.notes?.some((n: any) => n.id === noteId));
  check(
    "the response is a page, not a bare array",
    typeof percent.json?.hasMore === "boolean" &&
      typeof percent.json?.limit === "number" &&
      typeof percent.json?.offset === "number"
  );
  const live = await call("bear_search", { term: MARKER });
  check(
    "live results carry no status flags",
    live.json?.notes?.[0] != null &&
      !("isTrashed" in live.json.notes[0]) &&
      !("isArchived" in live.json.notes[0])
  );

  section("5. Tag lookup");
  const byTag = await call("bear_list_by_tag", { tag: `#${TAG.toUpperCase()}` });
  check("a leading # and the wrong case both resolve", byTag.json?.notes?.some((n: any) => n.id === noteId));
  check("bear_list_by_tag echoes the tag and pages", byTag.json?.tag != null && typeof byTag.json?.hasMore === "boolean");
  const viaSearch = await call("bear_search", { tag: TAG });
  check(
    "bear_search(tag) and bear_list_by_tag return identical notes",
    JSON.stringify(viaSearch.json?.notes) === JSON.stringify(byTag.json?.notes)
  );
  const tagNames = await listTagNames();
  check("the plain tag is listed", tagNames.includes(TAG));
  check("the multiword tag is listed", tagNames.includes(MULTIWORD_TAG));

  section("6. Append and prepend");
  await call("bear_append", { noteId, text: `\n\nAPPENDED-${MARKER}` });
  check(
    "appended text lands in the note",
    (await eventually("the append", async () => {
      const note = await call("bear_get_note", { noteId });
      return note.json?.content?.includes(`APPENDED-${MARKER}`) ? note.json : null;
    })) !== null
  );
  await call("bear_prepend", { noteId, text: `PREPENDED-${MARKER}\n\n` });
  check(
    "prepended text lands in the note",
    (await eventually("the prepend", async () => {
      const note = await call("bear_get_note", { noteId });
      return note.json?.content?.includes(`PREPENDED-${MARKER}`) ? note.json : null;
    })) !== null
  );

  section("7. Replace the whole note");
  const replacedTitle = `${TITLE} REPLACED`;
  await call("bear_replace_content", {
    noteId,
    title: replacedTitle,
    text: `Replaced body ${MARKER}`,
    tags: [TAG],
  });
  const replaced = await eventually("the replace", async () => {
    const note = await call("bear_get_note", { noteId });
    return note.json?.title === replacedTitle ? note.json : null;
  });
  check("mode=replace_all replaces the title too", replaced !== null);
  check("the body is the new text", replaced?.content?.includes(`Replaced body ${MARKER}`) === true);
  check("no bare '# ' heading was written", replaced?.content?.startsWith("# \n") !== true);

  section("8. Rename a tag while the note is live");
  await call("bear_rename_tag", { name: TAG, newName: RENAMED_TAG });
  const renamed = await eventually("the tag rename", async () => {
    const note = await call("bear_get_note", { noteId });
    return note.json?.tags?.includes(RENAMED_TAG) ? note.json : null;
  });
  check("the note carries the new tag name", renamed !== null);
  check("the old tag name is gone from the note", renamed?.tags?.includes(TAG) !== true);
  const afterRename = await listTagNames();
  check("bear_list_tags shows the new name", afterRename.includes(RENAMED_TAG));
  check("bear_list_tags no longer shows the old name", !afterRename.includes(TAG));
  check(
    "the renamed tag is looked up under its new name",
    (await call("bear_list_by_tag", { tag: RENAMED_TAG })).json?.notes?.some((n: any) => n.id === noteId) === true
  );

  section("9. Delete a tag while the note is live");
  // Deleted before the note is trashed on purpose: once the note is gone from
  // the live set the tag drops out of bear_list_tags anyway, and the check
  // would pass whether or not delete-tag did anything.
  await call("bear_delete_tag", { name: `#${MULTIWORD_TAG}#` });
  const afterDelete = await eventually("the tag deletion", async () => {
    const remaining = await listTagNames();
    return remaining.includes(MULTIWORD_TAG) ? null : remaining;
  });
  check("a tag supplied in Bear's own #multiword# form is deleted", afterDelete !== null);
  const strippedNote = await call("bear_get_note", { noteId });
  check("the deleted tag is off the note", strippedNote.json?.tags?.includes(MULTIWORD_TAG) !== true);

  section("10. Input validation");
  const blankTitle = await call("bear_create_note", { title: "   ", text: "x" });
  check("a blank title is rejected", blankTitle.isError, blankTitle.text.slice(0, 120));
  const blankTag = await call("bear_list_by_tag", { tag: "  " });
  check("bear_list_by_tag rejects a blank tag", blankTag.isError, blankTag.text.slice(0, 120));
  const hashOnly = await call("bear_search", { tag: "#" });
  check("bear_search treats a '#'-only tag as no filter", !hashOnly.isError && (hashOnly.json?.count ?? 0) > 0);
  const unknown = await call("bear_get_note", { noteId: "NO-SUCH-NOTE" });
  check("an unknown note id is an error", unknown.isError, unknown.text.slice(0, 120));
  const oversized = await call("bear_create_note", { title: "oversized", text: "ä".repeat(120_000) });
  check(
    "an oversized payload is refused rather than truncated",
    oversized.isError && /character limit/.test(oversized.text),
    oversized.text.slice(0, 160)
  );

  section("11. Paging");
  const first = await call("bear_search", { limit: 2 });
  const second = await call("bear_search", { limit: 2, offset: 2 });
  check("the first page is capped and reports more", first.json?.count === 2 && first.json?.hasMore === true);
  check(
    "an offset returns different notes",
    !first.json?.notes?.some((note: any) => second.json?.notes?.some((other: any) => other.id === note.id))
  );

  section("12. Archive, then clean up");
  await call("bear_archive_note", { noteId });
  check(
    "bear_get_note reports the note as archived",
    (await eventually("the archive", async () => {
      const note = await call("bear_get_note", { noteId });
      return note.json?.isArchived === true ? note.json : null;
    })) !== null
  );
  const archiveList = await call("bear_list_archived", { limit: 100 });
  check(
    "it appears in bear_list_archived carrying isArchived",
    archiveList.json?.notes?.some((note: any) => note.id === noteId && note.isArchived === true)
  );
  const liveAfterArchive = await call("bear_search", { term: MARKER });
  check("it has left the live search results", !liveAfterArchive.json?.notes?.some((note: any) => note.id === noteId));

  await call("bear_trash_note", { noteId });
  check(
    "an archived note can still be trashed",
    (await eventually("the trash", async () => {
      const note = await call("bear_get_note", { noteId });
      return note.json?.isTrashed === true ? note.json : null;
    })) !== null
  );

  // Whatever survives the run. Bear keeps the ZSFNOTETAG row around after the
  // last note using it is gone, but a tag with no live notes is invisible to
  // bear_list_tags, so this is housekeeping rather than an assertion.
  for (const tag of [RENAMED_TAG, NESTED_TAG, MULTIWORD_TAG, TAG]) {
    await call("bear_delete_tag", { name: tag });
  }
  const leftovers = (await listTagNames()).filter(name => name.startsWith(`mcp-e2e-${stamp}`));
  check("no test tag is left visible in bear_list_tags", leftovers.length === 0, leftovers.join(" | "));
};

try {
  await run();
} catch (error) {
  failed++;
  console.log(`\nHARNESS ERROR: ${(error as Error).message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
proc.kill();
process.exit(failed === 0 ? 0 : 1);
