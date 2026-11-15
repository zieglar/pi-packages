import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import { assertPrivateSocketDirectory } from "../../runtime/private-unix-socket.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** The socket directory is the access boundary: only its owner may reach the MCP endpoint. */
export async function startLocalMcpHttp(socketPath: string, createMcpServer: () => Server): Promise<{ close(): Promise<void> }> {
  assertPrivateSocketDirectory(socketPath);
  const http = createServer((req, res) => {
    if (req.headers.origin !== undefined || req.headers.host !== "localhost") {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.once("close", () => { void server.close(); });
    void (async () => {
      // SAFETY: SDK HTTP transport implements Transport at runtime; accessor optionality differs under exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
      void server.close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(socketPath, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    await new Promise<void>(resolve => http.close(() => resolve()));
    throw error;
  }
  return { close: () => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) };
}
