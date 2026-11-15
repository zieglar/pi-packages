import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";
import { startLocalMcpHttp } from "../../../src/control/mcp/http-transport.js";

function call(socketPath: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/mcp", method: "POST", headers: {
      host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers,
    } }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("local MCP HTTP transport", () => {
  it("serves the existing ping tool over a private socket and rejects browser origins", async () => {
    const root = mkdtempSync(join(tmpdir(), "ce-http-"));
    const socket = join(root, "mcp.sock");
    let http: Awaited<ReturnType<typeof startLocalMcpHttp>> | undefined;
    try {
      http = await startLocalMcpHttp(socket, () => createExchangeMcpServer());
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      await expect(startLocalMcpHttp(socket, () => createExchangeMcpServer())).rejects.toThrow();
      const initialize = await call(socket, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } });
      expect(initialize.status).toBe(200);
      expect(initialize.body).toContain("pi-chat-exchange");
      const ping = await call(socket, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } });
      expect(ping.status).toBe(200);
      expect(ping.body).not.toContain('"isError":true');
      expect((await call(socket, {}, { origin: "https://evil.example" })).status).toBe(403);
      expect((await call(socket, {}, { host: "evil.example" })).status).toBe(403);
    } finally {
      await http?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("refuses a private-mode directory with a granting ACL", async () => {
    const root = mkdtempSync(join(tmpdir(), "ce-http-acl-"));
    let http: Awaited<ReturnType<typeof startLocalMcpHttp>> | undefined;
    let refusal: unknown;
    try {
      execFileSync("/bin/chmod", ["+a", "everyone allow search", root]);
      try { http = await startLocalMcpHttp(join(root, "mcp.sock"), () => createExchangeMcpServer()); }
      catch (error) { refusal = error; }
      expect(refusal).toBeDefined();
    } finally {
      await http?.close();
      execFileSync("/bin/chmod", ["-N", root]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a socket directory accessible to other users", async () => {
    const root = mkdtempSync(join(tmpdir(), "ce-http-unsafe-"));
    try {
      chmodSync(root, 0o755);
      await expect(startLocalMcpHttp(join(root, "mcp.sock"), () => createExchangeMcpServer())).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
