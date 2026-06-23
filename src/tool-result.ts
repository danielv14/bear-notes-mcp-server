// Pure shaping of MCP tool results. Kept apart from server.ts so it can be
// tested without booting the server.

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

// Shapes a handler's return value into a tool result. A string is sent as-is;
// anything else is serialized as pretty JSON. The one place success output is
// formatted.
export const toToolResult = (value: string | object): ToolResult => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
};

// The one place an error becomes a tool result.
export const handleError = (error: unknown): ToolResult => {
  const message = error instanceof Error ? error.message : "An unknown error occurred";
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true
  };
};
