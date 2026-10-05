#!/usr/bin/env node
/**
 * stdio entrypoint for the pi-handoff MCP smoke server.
 *
 * Intended launch forms:
 *   node dist/bin/mcp-stdio.js
 *   tunnel-client run --profile pi-handoff   (with --mcp-command "node .../mcp-stdio.js")
 *
 * stdout is reserved for MCP protocol frames; diagnostics go to stderr.
 */
import { runStdioServer } from "../mcp/server.js";

runStdioServer().catch((error: unknown) => {
  console.error("pi-handoff MCP stdio server failed:", error);
  process.exitCode = 1;
});
