import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createBearTables, CORE_DATA_2021 } from "./bear-fixture";
import {
  setBearUrlRunner,
  resetBearUrlRunner,
  createNote,
  appendToNote,
  prependToNote,
  replaceNoteContent,
  trashNote,
  archiveNote,
  renameTag,
  deleteTag,
  MAX_BEAR_URL_LENGTH,
} from "./bear";

// LIVE carries `work/project`, which Bear also links to the parent `work`
// without `#work` being written in the note.
const buildFixture = (): Database => {
  const db = new Database(":memory:");
  createBearTables(db);
  db.run(
    `INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, ZTITLE, ZTEXT, ZCREATIONDATE, ZMODIFICATIONDATE, ZTRASHED, ZARCHIVED) VALUES
      (1, 'LIVE', 'Live', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 0),
      (2, 'TRASHED', 'Trashed', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 1, 0),
      (3, 'ARCHIVED', 'Archived', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, 0, 1),
      (4, 'UNTAGGED', 'Untagged', 'body', ${CORE_DATA_2021}, ${CORE_DATA_2021}, NULL, NULL)`
  );
  db.run(`INSERT INTO ZSFNOTETAG (Z_PK, ZTITLE) VALUES (10, 'work'), (11, 'work/project'), (12, 'my tag'), (13, 'workshop')`);
  db.run(`INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (1, 10), (1, 11), (1, 12), (1, 13)`);
  return db;
};

const db = buildFixture();

let captured: string[] = [];

beforeEach(() => {
  captured = [];
  setBearUrlRunner(async (url) => {
    captured.push(url);
    return { ok: true };
  });
});

afterEach(() => {
  resetBearUrlRunner();
});

const url = (action: string, text: string) =>
  `bear://x-callback-url/${action}?${text}`;

describe("write operations build the expected Bear URL", () => {
  test("createNote bakes the title as H1, prepends tags, and sends no separate title param", async () => {
    await createNote("My Note", "Body text", ["work", "ideas"]);
    const expectedText = encodeURIComponent("# My Note\n#work #ideas\n\nBody text");
    expect(captured).toEqual([url("create", `text=${expectedText}&open_note=no&show_window=no`)]);
    expect(captured[0]).not.toContain("title=");
  });

  test("appendToNote uses add-text with mode=append", async () => {
    await appendToNote("LIVE", "more text", db);
    expect(captured).toEqual([
      url("add-text", `id=LIVE&text=${encodeURIComponent("more text")}&mode=append&exclude_trashed=yes&open_note=no&show_window=no`),
    ]);
  });

  test("prependToNote uses add-text with mode=prepend", async () => {
    await prependToNote("LIVE", "intro text", db);
    expect(captured).toEqual([
      url("add-text", `id=LIVE&text=${encodeURIComponent("intro text")}&mode=prepend&exclude_trashed=yes&open_note=no&show_window=no`),
    ]);
  });

  test("replaceNoteContent uses the same rendering rule as createNote with mode=replace_all", async () => {
    await replaceNoteContent("LIVE", "Title", "body", ["t"], db);
    const expectedText = encodeURIComponent("# Title\n#t\n\nbody");
    expect(captured).toEqual([
      url("add-text", `id=LIVE&text=${expectedText}&mode=replace_all&exclude_trashed=yes&open_note=no&show_window=no`),
    ]);
  });

  test("trashNote sends the trash action, without open_note", async () => {
    await trashNote("LIVE", db);
    expect(captured).toEqual([url("trash", "id=LIVE&show_window=no")]);
  });

  test("archiveNote sends the archive action, without open_note", async () => {
    await archiveNote("LIVE", db);
    expect(captured).toEqual([url("archive", "id=LIVE&show_window=no")]);
  });

  test("renameTag sends name and new_name, the parameter names Bear documents", async () => {
    await renameTag("old tag", "new tag");
    expect(captured).toEqual([
      url("rename-tag", `name=${encodeURIComponent("old tag")}&new_name=${encodeURIComponent("new tag")}&show_window=no`),
    ]);
  });

  test("deleteTag sends the delete-tag action", async () => {
    await deleteTag("temp");
    expect(captured).toEqual([url("delete-tag", "name=temp&show_window=no")]);
  });

  test("tag actions strip a leading #, which Bear does not store", async () => {
    await renameTag("#old", "#new");
    await deleteTag("#temp");
    expect(captured).toEqual([
      url("rename-tag", "name=old&new_name=new&show_window=no"),
      url("delete-tag", "name=temp&show_window=no"),
    ]);
  });

  test("a blank tag name is refused instead of sent as an empty parameter", async () => {
    await expect(deleteTag("  ")).rejects.toThrow(/needs a tag name/);
    await expect(renameTag("#", "new")).rejects.toThrow(/needs a tag name/);
    await expect(renameTag("old", "")).rejects.toThrow(/needs a tag name/);
    expect(captured).toEqual([]);
  });
});

describe("replaceNoteContent and the note's tags", () => {
  const sentText = () => decodeURIComponent(captured[0].match(/text=([^&]*)/)![1]);

  test("omitted tags keep the note's current ones, without writing implied parent tags", async () => {
    await replaceNoteContent("LIVE", "Title", "body", undefined, db);
    expect(sentText()).toBe("# Title\n#my tag# #work/project #workshop\n\nbody");
  });

  test("an empty tags array clears them", async () => {
    await replaceNoteContent("LIVE", "Title", "body", [], db);
    expect(sentText()).toBe("# Title\n\nbody");
  });

  test("an untagged note gets no tag line", async () => {
    await replaceNoteContent("UNTAGGED", "Title", "body", undefined, db);
    expect(sentText()).toBe("# Title\n\nbody");
  });
});

describe("writes check the target note before sending", () => {
  const writes: Array<[string, (noteId: string) => Promise<void>]> = [
    ["append", noteId => appendToNote(noteId, "x", db)],
    ["prepend", noteId => prependToNote(noteId, "x", db)],
    ["replace", noteId => replaceNoteContent(noteId, "T", "x", [], db)],
    ["trash", noteId => trashNote(noteId, db)],
    ["archive", noteId => archiveNote(noteId, db)],
  ];

  for (const [name, write] of writes) {
    test(`${name} refuses an unknown id and sends nothing`, async () => {
      await expect(write("NOPE")).rejects.toThrow("Note not found: NOPE");
      expect(captured).toEqual([]);
    });

    test(`${name} refuses a blank id and sends nothing`, async () => {
      await expect(write("   ")).rejects.toThrow(/needs a note ID/);
      expect(captured).toEqual([]);
    });
  }

  for (const [name, write] of writes.filter(([name]) => name !== "archive")) {
    test(`${name} refuses a trashed note`, async () => {
      await expect(write("TRASHED")).rejects.toThrow("Note TRASHED is in the trash");
      expect(captured).toEqual([]);
    });
  }

  test("archive refuses an archived note", async () => {
    await expect(archiveNote("ARCHIVED", db)).rejects.toThrow("Note ARCHIVED is already archived");
    expect(captured).toEqual([]);
  });

  test("text can still be added to an archived note, and a NULL flag counts as live", async () => {
    await appendToNote("ARCHIVED", "x", db);
    await appendToNote("UNTAGGED", "x", db);
    expect(captured).toHaveLength(2);
  });

  test("the refusal names the id but not the note's content", async () => {
    let caught: Error | undefined;
    try {
      await trashNote("TRASHED", db);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).not.toContain("Trashed");
    expect(caught?.message).not.toContain("body");
  });
});

describe("write failures", () => {
  test("a runner that throws reports the action and never leaks the note content", async () => {
    setBearUrlRunner(async () => {
      throw new Error("open failed");
    });
    let caught: Error | undefined;
    try {
      await createNote("Secret Title", "secret body", ["private"]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("Failed to call Bear action: create");
    expect(caught?.message).not.toContain("Secret Title");
    expect(caught?.message).not.toContain("secret body");
    expect(caught?.message).not.toContain("private");
  });

  test("a Bear-reported failure is an error, not a success", async () => {
    setBearUrlRunner(async () => ({ ok: false, reason: "Bear rejected the request" }));
    await expect(deleteTag("secret-tag")).rejects.toThrow(/Failed to call Bear action: delete-tag/);
  });

  test("a failing tag action does not leak the tag name into the error", async () => {
    setBearUrlRunner(async () => ({ ok: false, reason: "Bear rejected the request" }));
    let caught: Error | undefined;
    try {
      await renameTag("confidential-project", "also-confidential");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("rename-tag");
    expect(caught?.message).not.toContain("confidential-project");
    expect(caught?.message).not.toContain("also-confidential");
  });
});

describe("the URL size guard", () => {
  // The guard measures the encoded URL, so the body that trips it is shorter
  // than the limit itself.
  const bodyOfEncodedLength = (target: number, char: string): string => {
    const perChar = encodeURIComponent(char).length;
    return char.repeat(Math.ceil(target / perChar));
  };

  test("a note just under the limit is sent", async () => {
    await createNote("T", bodyOfEncodedLength(MAX_BEAR_URL_LENGTH - 500, "a"));
    expect(captured).toHaveLength(1);
    expect(captured[0].length).toBeLessThanOrEqual(MAX_BEAR_URL_LENGTH);
  });

  test("a note over the limit is refused instead of silently truncated", async () => {
    await expect(
      createNote("T", bodyOfEncodedLength(MAX_BEAR_URL_LENGTH + 1000, "a"))
    ).rejects.toThrow(/over the .* character limit/);
    expect(captured).toEqual([]);
  });

  test("non-ASCII content trips the guard at a third of the character count", async () => {
    // "ä" encodes to 6 characters (%C3%A4), so this body is far under the
    // limit as text and far over it once encoded.
    const body = bodyOfEncodedLength(MAX_BEAR_URL_LENGTH + 1000, "ä");
    expect(body.length).toBeLessThan(MAX_BEAR_URL_LENGTH);
    await expect(createNote("T", body)).rejects.toThrow(/over the .* character limit/);
    expect(captured).toEqual([]);
  });

  test("the refusal names the sizes but not the note content", async () => {
    let caught: Error | undefined;
    try {
      await replaceNoteContent(
        "LIVE",
        "Secret Title",
        bodyOfEncodedLength(MAX_BEAR_URL_LENGTH + 1000, "s"),
        ["private"],
        db
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain(String(MAX_BEAR_URL_LENGTH));
    expect(caught?.message).not.toContain("Secret Title");
    expect(caught?.message).not.toContain("private");
  });
});
