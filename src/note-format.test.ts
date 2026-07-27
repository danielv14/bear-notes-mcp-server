import { test, expect, describe } from "bun:test";
import { renderNoteMarkdown, buildBearUrl, normalizeTagName } from "./note-format";

describe("renderNoteMarkdown", () => {
  test("title becomes an H1 on the first line", () => {
    expect(renderNoteMarkdown({ title: "My Note", text: "Body" })).toBe("# My Note\n\nBody");
  });

  test("tags render on their own line between title and content", () => {
    expect(renderNoteMarkdown({ title: "My Note", text: "Body", tags: ["work", "ideas"] }))
      .toBe("# My Note\n#work #ideas\n\nBody");
  });

  test("an empty tags array adds no tag line", () => {
    expect(renderNoteMarkdown({ title: "My Note", text: "Body", tags: [] }))
      .toBe("# My Note\n\nBody");
  });

  test("a leading #tag in the content is not mistaken for the title (3e3842e)", () => {
    const markdown = renderNoteMarkdown({ title: "Real Title", text: "#work this should stay content" });
    expect(markdown.startsWith("# Real Title\n")).toBe(true);
    expect(markdown).toBe("# Real Title\n\n#work this should stay content");
  });

  test("a blank title is rejected rather than rendered as a bare '# ' heading", () => {
    expect(() => renderNoteMarkdown({ title: "", text: "# Real Title\nbody" }))
      .toThrow(/title must not be empty/i);
    expect(() => renderNoteMarkdown({ title: "   ", text: "body" }))
      .toThrow(/title must not be empty/i);
  });
});

describe("tag rendering", () => {
  test("a tag containing whitespace gets Bear's closing hash so it stays one tag", () => {
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["my tag"] }))
      .toBe("# T\n#my tag#\n\nb");
  });

  test("a tag supplied with a leading # renders as one tag, not an H2 heading", () => {
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["#already", "##twice"] }))
      .toBe("# T\n#already #twice\n\nb");
  });

  test("nested tags keep their slashes", () => {
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["a/b"] }))
      .toBe("# T\n#a/b\n\nb");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["  work  "] }))
      .toBe("# T\n#work\n\nb");
  });

  test("a tag that is empty or only '#' is dropped", () => {
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["", "  ", "#", "work"] }))
      .toBe("# T\n#work\n\nb");
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["", "#"] }))
      .toBe("# T\n\nb");
  });
});

describe("normalizeTagName", () => {
  test("strips the leading # and surrounding whitespace", () => {
    expect(normalizeTagName("#work")).toBe("work");
    expect(normalizeTagName("  #work  ")).toBe("work");
    expect(normalizeTagName("##work")).toBe("work");
    expect(normalizeTagName("work")).toBe("work");
  });

  test("leaves nested tags and inner spaces alone", () => {
    expect(normalizeTagName("#a/b")).toBe("a/b");
    expect(normalizeTagName("my tag")).toBe("my tag");
  });

  test("accepts Bear's own multiword form, so a copied tag round-trips", () => {
    expect(normalizeTagName("#my tag#")).toBe("my tag");
    expect(normalizeTagName(" #my tag# ")).toBe("my tag");
    expect(renderNoteMarkdown({ title: "T", text: "b", tags: ["#my tag#"] }))
      .toBe("# T\n#my tag#\n\nb");
  });

  test("keeps a trailing # that is part of a single-word name", () => {
    expect(normalizeTagName("c#")).toBe("c#");
    expect(normalizeTagName("#f#")).toBe("f#");
  });

  test("returns undefined when nothing usable is left", () => {
    expect(normalizeTagName("")).toBeUndefined();
    expect(normalizeTagName("   ")).toBeUndefined();
    expect(normalizeTagName("#")).toBeUndefined();
    expect(normalizeTagName(" ## ")).toBeUndefined();
  });
});

describe("buildBearUrl", () => {
  test("always appends show_window=no", () => {
    expect(buildBearUrl("trash", { id: "ABC" }))
      .toBe("bear://x-callback-url/trash?id=ABC&show_window=no");
  });

  test("url-encodes spaces and reserved characters in values", () => {
    expect(buildBearUrl("create", { text: "a & b = c" }))
      .toBe("bear://x-callback-url/create?text=a%20%26%20b%20%3D%20c&show_window=no");
  });

  test("preserves param insertion order, with show_window last", () => {
    expect(buildBearUrl("add-text", { id: "X", text: "hi", mode: "append" }))
      .toBe("bear://x-callback-url/add-text?id=X&text=hi&mode=append&show_window=no");
  });
});
