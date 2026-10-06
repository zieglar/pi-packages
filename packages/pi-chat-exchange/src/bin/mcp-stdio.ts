#!/usr/bin/env node
/**
 * stdio entrypoint for the pi-chat-exchange MCP smoke server (composition only).
 *
 * Intended launch forms:
 *   node dist/bin/mcp-stdio.js
 *   tunnel-client run --profile pi-chat-exchange   (with --mcp-command "node .../mcp-stdio.js")
 *
 * stdout is reserved for MCP protocol frames; diagnostics go to stderr.
 */
import { runStdioServer } from "../control/mcp/server.js";

runStdioServer().catch((error: unknown) => {
  console.error("pi-chat-exchange MCP stdio server failed:", error);
  process.exitCode = 1;
});
