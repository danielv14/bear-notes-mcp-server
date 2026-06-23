import { test, expect, describe } from "bun:test";
import { toToolResult, handleError } from "./tool-result";

describe("toToolResult", () => {
  test("passes a string through unchanged", () => {
    expect(toToolResult("Created note: X")).toEqual({
      content: [{ type: "text", text: "Created note: X" }],
    });
  });

  test("serializes an object as pretty JSON", () => {
    const result = toToolResult({ count: 2, notes: [] });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ count: 2, notes: [] }, null, 2) }],
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("handleError", () => {
  test("surfaces an Error's message and flags isError", () => {
    expect(handleError(new Error("Note not found: ABC"))).toEqual({
      content: [{ type: "text", text: "Error: Note not found: ABC" }],
      isError: true,
    });
  });

  test("falls back for non-Error throwables", () => {
    expect(handleError("boom")).toEqual({
      content: [{ type: "text", text: "Error: An unknown error occurred" }],
      isError: true,
    });
  });
});
