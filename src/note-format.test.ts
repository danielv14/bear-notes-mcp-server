import { test, expect, describe } from "bun:test";
import { renderNoteMarkdown, buildBearUrl } from "./note-format";

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
