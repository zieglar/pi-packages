import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectMcpRuntimeMarker,
  mcpRuntimeSourceIdentity,
  writeMcpRuntimeMarker,
} from "../../src/tunnel/mcp-runtime-marker.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(join(os.tmpdir(), "ce-mcp-runtime-")); roots.push(root);
  const packageRoot = join(root, "package");
  fs.mkdirSync(join(packageRoot, "dist"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@zieglar/pi-chat-exchange", version: "0.3.6" }), { mode: 0o600 });
  fs.writeFileSync(join(packageRoot, "dist", "entry.js"), "export const value = 1;\n", { mode: 0o600 });
  const bindingPath = join(root, "messaging.json");
  fs.writeFileSync(bindingPath, "{}\n", { mode: 0o600 });
  return { root, packageRoot, bindingPath };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("MCP runtime source marker", () => {
  it("reports the exact package version and launch-time source digest", () => {
    const f = fixture();
    const source = mcpRuntimeSourceIdentity(f.packageRoot);
    writeMcpRuntimeMarker({ bindingPath: f.bindingPath, identity: { pid: 41, startedKey: "process-start" }, source });

    expect(inspectMcpRuntimeMarker({
      bindingPath: f.bindingPath, packageRoot: f.packageRoot, process: { pid: 41, startedKey: "process-start" },
    })).toEqual({ state: "CURRENT", packageVersion: "0.3.6", launchSourceDigest: source.sourceDigest,
      currentSourceDigest: source.sourceDigest });
  });

  it("detects code replaced after the MCP process started", () => {
    const f = fixture();
    const source = mcpRuntimeSourceIdentity(f.packageRoot);
    writeMcpRuntimeMarker({ bindingPath: f.bindingPath, identity: { pid: 42, startedKey: "old-start" }, source });
    fs.writeFileSync(join(f.packageRoot, "dist", "entry.js"), "export const value = 2;\n", { mode: 0o600 });

    expect(inspectMcpRuntimeMarker({
      bindingPath: f.bindingPath, packageRoot: f.packageRoot, process: { pid: 42, startedKey: "old-start" },
    })).toMatchObject({ state: "STALE", packageVersion: "0.3.6", launchSourceDigest: source.sourceDigest });
  });

  it("does not trust a missing marker or a marker owned by another process identity", () => {
    const f = fixture();
    expect(inspectMcpRuntimeMarker({
      bindingPath: f.bindingPath, packageRoot: f.packageRoot, process: { pid: 43, startedKey: "current-start" },
    })).toEqual({ state: "UNVERIFIED" });

    const source = mcpRuntimeSourceIdentity(f.packageRoot);
    writeMcpRuntimeMarker({ bindingPath: f.bindingPath, identity: { pid: 44, startedKey: "foreign-start" }, source });
    expect(inspectMcpRuntimeMarker({
      bindingPath: f.bindingPath, packageRoot: f.packageRoot, process: { pid: 43, startedKey: "current-start" },
    })).toEqual({ state: "UNVERIFIED" });
  });

  it("refuses symlinked and oversized marker input", () => {
    const f = fixture();
    const path = `${f.bindingPath}.runtime.json`;
    const source = mcpRuntimeSourceIdentity(f.packageRoot);
    writeMcpRuntimeMarker({ bindingPath: f.bindingPath, identity: { pid: 44, startedKey: "current-start" }, source });
    const foreign = join(f.root, "foreign-runtime.json"); fs.renameSync(path, foreign); fs.symlinkSync(foreign, path);
    expect(inspectMcpRuntimeMarker({ bindingPath: f.bindingPath, packageRoot: f.packageRoot,
      process: { pid: 44, startedKey: "current-start" } })).toEqual({ state: "UNVERIFIED" });
    fs.unlinkSync(path); fs.writeFileSync(path, "x".repeat(5000), { mode: 0o600 });
    expect(inspectMcpRuntimeMarker({ bindingPath: f.bindingPath, packageRoot: f.packageRoot,
      process: { pid: 44, startedKey: "current-start" } })).toEqual({ state: "UNVERIFIED" });
  });
});
