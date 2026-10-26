import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

it("prepares the owner-authorized MIT candidate without consumer hooks", () => {
  const manifest = JSON.parse(read("package.json"));
  expect(manifest.version).toBe("0.2.0");
  // Owner authorization covers CE, not third-party scopes. Preserve npm's own
  // refusal until the exact-version third-party license evidence gaps close.
  expect(manifest.private).toBe(true);
  expect(manifest.publishConfig).toEqual({ access: "public", registry: "https://registry.npmjs.org/" });
  expect(manifest.repository.directory).toBe("packages/pi-chat-exchange");
  expect(manifest.license).toBe("MIT");
  expect(read("LICENSE")).toContain("Copyright (c) 2026 zieglar");
  expect(read("LICENSE")).toContain("The above copyright notice and this permission notice shall be included in all");
  expect(read("LICENSE")).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
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

it("keeps third-party evidence and cloud publication gates explicit in draft release materials", () => {
  const notes = read("docs/releases/0.2.0.md");
  for (const token of ["DRAFT", "MIT", "THIRD-PARTY EVIDENCE PENDING", "NOT_VERIFIED", "24.21.0", "1.3.0", "macOS arm64", "npm:@zieglar/pi-chat-exchange@0.2.0", "private"])
    expect(notes).toContain(token);
  // No corrupted-SRI consumer rejection negative exists. Only metadata plus
  // installed-payload byte identity may be claimed.
  expect(notes).toContain("integrity-rejection negative");
  expect(notes).toContain("repo-only");
  expect(read("CHANGELOG.md")).toContain("UNRELEASED");
});

it("records the candidate's actual user-visible feature delta, not only packaging", () => {
  const changelog = read("CHANGELOG.md");
  for (const token of ["ce_ack", "/ce-tunnel deactivate", "/ce-tunnel doctor", "24.22.1", "24.21.0"])
    expect(changelog, token).toContain(token);
  // 0.1.1 was never published; no entry may imply a prior public release.
  expect(changelog).not.toMatch(/0\.1\.1[^\n]*\b(released|available|published)\b/i);
  // The queued ACK changeset is DESCRIBED here and consumed by a future
  // Changesets version PR; this delta never consumes or edits root changesets.
  expect(changelog).toContain(".changeset/ce-e2b-ack-mcp.md");
  expect(changelog).toContain("Changesets");
});

it("reports the candidate version through MCP server metadata", async () => {
  const { SERVER_VERSION } = await import("../../src/control/mcp/server.js");
  expect(SERVER_VERSION).toBe(JSON.parse(read("package.json")).version);
});
