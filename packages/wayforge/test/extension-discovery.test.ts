import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Regression for the Alpha 0 dogfood finding: the isolated launcher originally
// wrote extension shims as `.mjs`, and Pi 1.x silently skipped them
// (isExtensionFile only accepts `.ts`/`.js`), so the dogfood session loaded
// zero extensions with no visible error. This test exercises Pi's real
// discoverAndLoadExtensions against a replica of the launcher layout.
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const ROOT = resolve(__dirname, "..");
const FACTORY = `export default function wayforgeDiscoveryProbe() {}\n`;

const bus = {
  emit: () => {},
  on: () => () => {},
};

const tmpDirs: string[] = [];

function makeAgentDir(): string {
  const agentDir = mkdtempSync(join(tmpdir(), "wayforge-ext-discovery-"));
  tmpDirs.push(agentDir);
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  return agentDir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi extension discovery against the launcher shim layout", () => {
  it("loads .js shims discovered under agentDir/extensions/", async () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "extensions", "wayforge.js"), FACTORY);
    writeFileSync(join(agentDir, "extensions", "pi-subagents.js"), FACTORY);

    const result = await discoverAndLoadExtensions([], ROOT, agentDir, bus as never);

    expect(result.errors).toEqual([]);
    expect(result.extensions.map((ext) => ext.path)).toHaveLength(2);
  });

  it("silently skips .mjs shims — the exact dogfood failure mode", async () => {
    const agentDir = makeAgentDir();
    writeFileSync(join(agentDir, "extensions", "wayforge.mjs"), FACTORY);
    writeFileSync(join(agentDir, "extensions", "pi-subagents.mjs"), FACTORY);

    const result = await discoverAndLoadExtensions([], ROOT, agentDir, bus as never);

    // Pi 1.x skips .mjs files entirely: neither loaded nor reported as errors.
    expect(result.extensions).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });
});
