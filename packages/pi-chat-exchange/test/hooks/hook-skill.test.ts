import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CeHookRunner } from "../../src/hooks/runner.js";
import { parseHookRules } from "../../src/hooks/config.js";
import type { CeCommittedMessageEvent } from "../../src/hooks/events.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const script = join(packageRoot, "skills/ce-hook-script/examples/file-notification.py");
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const roots: string[] = [];
const temporary = () => { const p = mkdtempSync(join(tmpdir(), "ce-hook-skill-")); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const event: CeCommittedMessageEvent = {
  schemaVersion: 1, event: "ce.message.committed.v1", eventId: "evt_test", eventKey: "ho_test/1", messageId: "msg_test", exchangeId: "ho_test",
  sender: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipient: { adapter: "pi", endpointId: "pi/main" },
  createdAt: "2026-10-31T00:00:00.000Z", payloadDigest: "a".repeat(64), payloadLength: 7,
};

it("ships a discoverable skill and example through the production packer", async () => {
  expect(existsSync(script)).toBe(true);
  const skill = readFileSync(join(packageRoot, "skills/ce-hook-script/SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\nname: ce-hook-script\ndescription: Use when/m);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  expect(manifest.pi.skills).toEqual(["./skills"]);
  const { loadSkills } = await import("@earendil-works/pi-coding-agent");
  const discovered = loadSkills({ cwd: packageRoot, agentDir: temporary(), includeDefaults: false, skillPaths: manifest.pi.skills.map((path: string) => resolve(packageRoot, path)) });
  expect(discovered.diagnostics).toEqual([]);
  expect(discovered.skills.map(skill => skill.name)).toEqual(["ce-hook-script"]);
  // Exercise actual npm inventory and staging, using existing dist without rebuilding it.
  // @ts-expect-error Author-side JavaScript packer has no declaration file.
  const { buildPackageArtifact } = await import("../../scripts/package-pi-extension.mjs");
  const result = buildPackageArtifact({ root: packageRoot, out: temporary() });
  const members = execFileSync("tar", ["-tzf", result.artifactPath], { encoding: "utf8" });
  for (const path of ["skills/ce-hook-script/SKILL.md", "skills/ce-hook-script/examples/file-notification.py"]) {
    expect(result.inventory).toContain(path);
    expect(members.split("\n")).toContain(`package/${path}`);
  }
}, 30000);

it("runs the Python example with exact runner metadata and isolates failure without replay or output leakage", async () => {
  expect(existsSync(script)).toBe(true);
  const directory = temporary();
  const output = join(directory, "notification.jsonl");
  const runner = new CeHookRunner({ directory, rules: parseHookRules([{ id: "notify", event: event.event, recipient: event.recipient, command: python, args: [script, output] }]) });
  runner.publish({ ...event, payloadText: "PAYLOAD_SECRET", capability: "CAPABILITY_SECRET" } as CeCommittedMessageEvent);
  await runner.close();
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(event);
  const failed = new CeHookRunner({ directory, rules: parseHookRules([{ id: "failure", event: event.event, recipient: event.recipient, command: python, args: [script, directory] }]) });
  failed.publish(event);
  await failed.close();
  const records = readFileSync(join(directory, "ce-hooks/executions.jsonl"), "utf8");
  expect(records).not.toMatch(/PAYLOAD_SECRET|CAPABILITY_SECRET|Traceback|notification rejected/);
  expect(records.split("\n").filter(Boolean).map(line => JSON.parse(line).status)).toEqual(["STARTED", "SUCCEEDED", "STARTED", "FAILED"]);
  const idle = new CeHookRunner({ directory, rules: [] });
  await idle.close();
  expect(readFileSync(output, "utf8").trim().split("\n")).toHaveLength(1);
});

it("rejects malformed, oversized, extra metadata and unsafe output without leaking input", () => {
  expect(existsSync(script)).toBe(true);
  const directory = temporary();
  const output = join(directory, "out");
  for (const input of ["{SECRET", "x".repeat(16385), JSON.stringify({ ...event, payloadText: "SECRET" }), JSON.stringify({ ...event, payloadLength: -1 }), JSON.stringify({ ...event, schemaVersion: true }), '{"schemaVersion":1,"schemaVersion":1}', JSON.stringify({ ...event, sender: { ...event.sender, session: "SECRET" } })]) {
    const result = spawnSync(python, [script, output], { input, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("notification rejected\n");
    expect(existsSync(output)).toBe(false);
  }
  const target = join(directory, "target");
  writeFileSync(target, "unchanged");
  symlinkSync(target, output);
  expect(spawnSync(python, [script, output], { input: JSON.stringify(event) }).status).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("unchanged");
  const validOutput = join(directory, "private.jsonl");
  for (let index = 0; index < 2; index++) {
    const result = spawnSync(python, [script, validOutput], { input: JSON.stringify(event), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }
  expect(readFileSync(validOutput, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([event, event]);
});
