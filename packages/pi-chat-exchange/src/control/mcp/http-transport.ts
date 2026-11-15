import { execFileSync } from "node:child_process";
import { lstatSync, chmodSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** The socket directory is the access boundary: only its owner may reach the MCP endpoint. */
export async function startLocalMcpHttp(socketPath: string, createMcpServer: () => Server): Promise<{ close(): Promise<void> }> {
  if (!isAbsolute(socketPath)) throw new Error("MCP socket path must be absolute");
  const socketDirectory = dirname(socketPath);
  if (realpathSync(socketDirectory) !== socketDirectory) throw new Error("MCP socket directory must be canonical");
  for (let path = socketDirectory; ; path = dirname(path)) {
    const stat = lstatSync(path);
    const uid = process.geteuid?.();
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
        (!stickyRoot && (stat.mode & 0o022) !== 0) ||
        (path === socketDirectory && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
      throw new Error("MCP socket directory or ancestor is not private and trusted");
    }
    // A Darwin ACL can grant access independently of POSIX mode.
    if (process.platform === "darwin") {
      let acl: string;
      try {
        acl = execFileSync("/bin/ls", ["-lde", path], {
          encoding: "utf8", timeout: 5_000, maxBuffer: 16_384,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch { throw new Error("MCP socket directory ACL could not be verified"); }
      const [header = "", ...entries] = acl.trimEnd().split("\n");
      if (!/^[bcdlps-][rwxStTs-]{9}[+@ ]/.test(header) ||
          entries.some(entry => !/^\s*\d+: \S+ deny [a-z_,]+$/.test(entry)) ||
          (header[10] === "+" && entries.length === 0)) {
        throw new Error("MCP socket directory ACL must not grant access");
      }
    }
    if (dirname(path) === path) break;
  }
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
