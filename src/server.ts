import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDatabase } from "./database.js";
import { createBearServer } from "./tools.js";

const server = createBearServer();

// One cleanup for every shutdown path. closeDatabase() nulls its handle, so
// calling it more than once is safe.
const shutdown = (): void => {
  closeDatabase();
};

// The path that actually happens: Claude Code shuts a stdio server down by
// closing its stdin, which ends the transport without delivering a signal.
// No process.exit here, so a normal shutdown can drain.
server.server.onclose = shutdown;

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

// Start server
const main = async () => {
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    console.error("Bear MCP server connected");
  } catch (error) {
    console.error("Failed to start server", error);
    process.exit(1);
  }
};

main();
