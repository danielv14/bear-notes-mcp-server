import { test, expect, describe, beforeEach, afterEach } from "bun:test";
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
    expect(captured).toEqual([url("create", `text=${expectedText}&show_window=no`)]);
    expect(captured[0]).not.toContain("title=");
  });

  test("appendToNote uses add-text with mode=append", async () => {
    await appendToNote("NOTE-ID", "more text");
    expect(captured).toEqual([
      url("add-text", `id=NOTE-ID&text=${encodeURIComponent("more text")}&mode=append&show_window=no`),
    ]);
  });

  test("prependToNote uses add-text with mode=prepend", async () => {
    await prependToNote("NOTE-ID", "intro text");
    expect(captured).toEqual([
      url("add-text", `id=NOTE-ID&text=${encodeURIComponent("intro text")}&mode=prepend&show_window=no`),
    ]);
  });

  test("replaceNoteContent uses the same rendering rule as createNote with mode=replace_all", async () => {
    await replaceNoteContent("NOTE-ID", "Title", "body", ["t"]);
    const expectedText = encodeURIComponent("# Title\n#t\n\nbody");
    expect(captured).toEqual([
      url("add-text", `id=NOTE-ID&text=${expectedText}&mode=replace_all&show_window=no`),
    ]);
  });

  test("trashNote sends the trash action", async () => {
    await trashNote("NOTE-ID");
    expect(captured).toEqual([url("trash", "id=NOTE-ID&show_window=no")]);
  });

  test("archiveNote sends the archive action", async () => {
    await archiveNote("NOTE-ID");
    expect(captured).toEqual([url("archive", "id=NOTE-ID&show_window=no")]);
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
        "NOTE-ID",
        "Secret Title",
        bodyOfEncodedLength(MAX_BEAR_URL_LENGTH + 1000, "s"),
        ["private"]
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain(String(MAX_BEAR_URL_LENGTH));
    expect(caught?.message).not.toContain("Secret Title");
    expect(caught?.message).not.toContain("private");
  });
});
