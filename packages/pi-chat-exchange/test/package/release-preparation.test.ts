import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

it("prepares the exact npm candidate without consumer hooks or invented licensing", () => {
  const manifest = JSON.parse(read("package.json"));
  expect(manifest.version).toBe("0.2.0");
  expect(manifest.private).not.toBe(true);
  expect(manifest.publishConfig).toEqual({ access: "public", registry: "https://registry.npmjs.org/" });
  expect(manifest.license).toBeUndefined(); // User authority is still pending.
  expect(manifest.scripts["test:distribution-npm"]).toContain("CE_DISTRIBUTION_MODE=managed-npm");
  expect(manifest.exports).toBeUndefined(); // Pi manifest is the entry, not a public library API.
  for (const hook of ["prepare", "prepack", "postpack", "preinstall", "install", "postinstall"])
    expect(manifest.scripts[hook]).toBeUndefined();
  for (const file of ["CHANGELOG.md", "docs/releases/0.2.0.md"])
    expect(manifest.files).toContain(file);
});

it("documents stop and normal release BEFORE native removal, preserving durable state", () => {
  const guide = read("docs/independent-install.md");
  expect(guide).not.toContain("取消注册，再删除 consumer 前缀即可");
  const procedure = guide.slice(guide.indexOf("## 5. 安全卸载"));
  const ordered = ["/ce-tunnel stop", "/ce-tunnel status", "STOPPED", "/ce-tunnel deactivate", "其他使用者", "退出", 'remove "npm:@zieglar/pi-chat-exchange@0.2.0"'];
  let at = -1;
  for (const token of ordered) {
    const next = procedure.indexOf(token, at + 1);
    expect(next, token).toBeGreaterThan(at);
    at = next;
  }
  expect(procedure).toContain("必须在原生 remove 前 STOP");
  for (const token of ["UNKNOWN", "外部 Owner", "Store", "profile", "凭据", "history", "不能自动证明", "原生", "已删除"])
    expect(procedure).toContain(token);
});

it("keeps license and cloud publication blockers explicit in draft release materials", () => {
  const notes = read("docs/releases/0.2.0.md");
  for (const token of ["DRAFT", "LICENSE PENDING", "NOT_VERIFIED", "24.21.0", "1.3.0", "macOS arm64", "npm:@zieglar/pi-chat-exchange@0.2.0"])
    expect(notes).toContain(token);
  expect(read("CHANGELOG.md")).toContain("UNRELEASED");
});

it("reports the candidate version through MCP server metadata", async () => {
  const { SERVER_VERSION } = await import("../../src/control/mcp/server.js");
  expect(SERVER_VERSION).toBe(JSON.parse(read("package.json")).version);
});
