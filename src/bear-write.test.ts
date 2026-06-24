import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  setBearUrlRunner,
  resetBearUrlRunner,
  createNote,
  appendToNote,
  prependToNote,
  replaceNoteContent,
  trashNote,
} from "./bear";

let captured: string[] = [];

beforeEach(() => {
  captured = [];
  setBearUrlRunner(async (url) => {
    captured.push(url);
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
});

describe("write failures", () => {
  test("report the action and never leak the note content into the error", async () => {
    setBearUrlRunner(async () => {
      throw new Error("open failed");
    });
    let caught: Error | undefined;
    try {
      await createNote("Secret Title", "secret body", ["private"]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("Failed to call Bear action: create");
    expect(caught?.message).not.toContain("Secret Title");
    expect(caught?.message).not.toContain("secret body");
    expect(caught?.message).not.toContain("private");
  });
});
