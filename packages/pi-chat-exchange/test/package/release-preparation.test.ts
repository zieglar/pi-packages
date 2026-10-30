import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

it("prepares the owner-authorized MIT package without consumer hooks", () => {
  const manifest = JSON.parse(read("package.json"));
  expect(manifest.version).toBe("0.2.2");
  // Owner authorization plus the completed third-party audit meet the
  // handoff's private-removal condition.
  expect(manifest.private).toBeUndefined();
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
  expect(manifest.files.some((file: string) => file.startsWith("docs/") || file.endsWith(".md"))).toBe(false);
});

it.each([
  { path: "docs/independent-install.md", heading: /^## 5\. Safe uninstall, upgrade and rollback$/m,
    ordered: ["/ce-tunnel stop", "/ce-tunnel status", "STOPPED", "/ce-tunnel deactivate", "other users", "Normally exit", 'remove "npm:@zieglar/pi-chat-exchange@0.2.0"'],
    safety: ["independently", "normal release/detach", "STOP before native remove", "UNKNOWN", "External Owner", "Store", "profile", "credentials", "history", "cannot automatically prove", "**deletes**"] },
  { path: "docs/independent-install.zh-CN.md", heading: /^## 5\. 安全卸载、升级与回滚$/m,
    ordered: ["/ce-tunnel stop", "/ce-tunnel status", "STOPPED", "/ce-tunnel deactivate", "其他使用者", "正常退出", 'remove "npm:@zieglar/pi-chat-exchange@0.2.0"'],
    safety: ["再独立", "正常 release/detach", "必须在原生 remove 前 STOP", "UNKNOWN", "外部 Owner", "Store", "profile", "凭据", "history", "不能自动证明", "已删除"] },
])("documents independent stop and normal release before removal in $path", ({ path, heading, ordered, safety }) => {
  const guide = read(path);
  const start = guide.search(heading);
  expect(start, path).toBeGreaterThanOrEqual(0);
  const procedure = guide.slice(start);
  let at = -1;
  for (const token of ordered) {
    const next = procedure.indexOf(token, at + 1);
    expect(next, token).toBeGreaterThan(at);
    at = next;
  }
  for (const token of safety) expect(procedure, token).toContain(token);
});

it("keeps third-party evidence and cloud verification limits explicit in release materials", () => {
  const notes = read("docs/releases/0.2.0.md");
  for (const token of ["MIT", "third-party evidence complete", "NOT_VERIFIED", "24.21.0", "1.3.0", "macOS arm64", "npm:@zieglar/pi-chat-exchange@0.2.0", "private: true` is removed"])
    expect(notes).toContain(token);
  // No corrupted-SRI consumer rejection negative exists. Only metadata plus
  // installed-payload byte identity may be claimed.
  expect(notes).toContain("integrity-rejection negative");
  expect(notes).toContain("repo-only");
  // Version-scoped neutral statements replacing the former time-bound
  // DRAFT/UNRELEASED labels: these stay true before AND after publication,
  // whereas a draft label becomes false the instant 0.2.0 ships and an
  // immutable npm tarball cannot be corrected without burning a version.
  expect(notes).toMatch(/^# 0\.2\.0$/m);
  expect(notes).toContain("## 0.2.0 scope");
  expect(notes).toContain("Certification target: **Node 24.21.0 + Pi 1.3.0 + macOS arm64**");
  expect(notes).toContain("not part of 0.2.0's certification");
  expect(notes).toContain("not a grant to relicense dependencies");
  // License evidence remains explicitly identified as a repository-only record.
  expect(notes).toContain("`docs/license-audit.md`");
  expect(notes).not.toMatch(/\]\([^)]*license-audit\.md\)/);
  const translated = read("docs/releases/0.2.0.zh-CN.md");
  expect(translated).toMatch(/^# 0\.2\.0$/m);
  expect(translated).toContain("## 0.2.0 范围");
  for (const token of ["MIT", "NOT_VERIFIED", "Node 24.21.0 + Pi 1.3.0 + macOS arm64", "24.22.1 不属于", "完整性拒绝负向测试", "不授予依赖再许可权", "docs/license-audit.md", "仅仓库"])
    expect(translated, token).toContain(token);
  const changelog = read("CHANGELOG.md");
  expect(changelog).toContain("\n## 0.2.0\n");
  expect(changelog).toContain("`private: true` is removed from the manifest");
  expect(changelog).toContain("never published to npm");
  expect(changelog).toContain("`docs/license-audit.md`");
  expect(changelog).not.toMatch(/\]\([^)]*license-audit\.md\)/);
  // Repository release materials must not carry a time-bound publication claim in either
  // direction, nor an author-side authorization-process statement that is
  // meaningless to a consumer and goes stale once performed.
  for (const member of ["README.md", "CHANGELOG.md", "docs/releases/0.2.0.md", "docs/independent-install.md", "pi-extension/README.md"])
    expect(read(member), member).not.toMatch(/DRAFT|UNRELEASED|\u5c1a\u672a\u516c\u5f00\u53d1\u5e03|\u6ca1\u6709\u516c\u5f00 npm|separate explicit authorization|publication still unauthorized|remain NOT performed/);
});

it("records 0.2.0's actual user-visible feature delta, not only packaging", () => {
  const changelog = read("CHANGELOG.md");
  for (const token of ["ce_ack", "/ce-tunnel deactivate", "/ce-tunnel doctor", "24.22.1", "24.21.0"])
    expect(changelog, token).toContain(token);
  // 0.1.1 was never published; no entry may imply a prior public release.
  expect(changelog).not.toMatch(/0\.1\.1[^\n]*\b(released|available|published)\b/i);
  // The queued ACK changeset is still queued and still only DESCRIBED here; a
  // future Changesets version PR consumes it. This delta never consumes or
  // edits root changesets, so the mechanism and this pin stay coherent.
  expect(changelog).toContain(".changeset/ce-e2b-ack-mcp.md");
  expect(changelog).toContain("Changesets");
});

it("reports the candidate version through MCP server metadata", async () => {
  const { SERVER_VERSION } = await import("../../src/control/mcp/server.js");
  expect(SERVER_VERSION).toBe(JSON.parse(read("package.json")).version);
});
