import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLaunchSourceMetadataProbe } from "../../../src/bin/source-metadata-probe-launch.js";

const SCOPE = "a".repeat(64);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("ignores malformed JSON and non-private control files", () => {
  const f = fixture();
  writeFileSync(f.control, "{MALFORMED_CANARY", { mode: 0o600 });
  expect(() => createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" })).not.toThrow();
  expect(existsSync(f.output)).toBe(false);
  f.arm(); chmodSync(f.control, 0o644);
  createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" });
  expect(existsSync(f.output)).toBe(false);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ce-source-probe-")); dirs.push(dir);
  const binding = join(dir, "launch.json"), control = binding + ".source-metadata-probe.json";
  const output = control + ".observation.json";
  const arm = (value: unknown = { version: 1, launchDigest: SCOPE, expiresAt: Date.now() + 60_000 }) =>
    writeFileSync(control, JSON.stringify(value), { mode: 0o600 });
  return { binding, control, output, arm };
}

it("does nothing without a private matching launch opt-in", () => {
  const f = fixture();
  createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" });
  expect(existsSync(f.output)).toBe(false);
  for (const control of [
    { version: 1, launchDigest: "b".repeat(64), expiresAt: Date.now() + 60_000 },
    { version: 1, launchDigest: SCOPE, expiresAt: Date.now() - 1 },
    { version: 1, launchDigest: SCOPE, expiresAt: Date.now() + 3_600_000 },
    { version: 1, launchDigest: SCOPE, expiresAt: Date.now() + 60_000, extra: "PRIVATE_CANARY" },
    { version: 2, launchDigest: SCOPE, expiresAt: Date.now() + 60_000 },
  ]) {
    f.arm(control);
    createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" });
    expect(existsSync(f.output)).toBe(false);
  }
});

it("records one private projection across instances without changing tool metadata", () => {
  const f = fixture(); f.arm();
  const metadata = { "openai/session": "PRIVATE_CANARY", headers: "HEADER_CANARY", token: "TOKEN_CANARY" };
  createLaunchSourceMetadataProbe(f.binding, SCOPE)(metadata);
  expect(existsSync(f.output)).toBe(true);
  const raw = readFileSync(f.output, "utf8"), row = JSON.parse(raw);
  expect(row).toMatchObject({ event: "SOURCE_METADATA_OBSERVATION", present: true, type: "string", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(raw).not.toMatch(/CANARY|headers|token|launchDigest/);
  expect(statSync(f.output).mode & 0o777).toBe(0o600);
  createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "OTHER_CANARY" });
  expect(readFileSync(f.output, "utf8")).toBe(raw);
  expect(metadata["openai/session"]).toBe("PRIVATE_CANARY");
});

it("treats an existing empty observation as unknown, never as permission to retry", () => {
  const f = fixture(); f.arm(); writeFileSync(f.output, "", { mode: 0o600 });
  createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" });
  expect(readFileSync(f.output, "utf8")).toBe("");
});

it("rejects symlink control and output paths without writing their targets", () => {
  const f = fixture(); const target = f.binding + ".target";
  writeFileSync(target, JSON.stringify({ version: 1, launchDigest: SCOPE, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  symlinkSync(target, f.control);
  expect(() => createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" })).not.toThrow();
  expect(existsSync(f.output)).toBe(false);
  rmSync(f.control); f.arm();
  symlinkSync(target, f.output); const before = readFileSync(target, "utf8");
  createLaunchSourceMetadataProbe(f.binding, SCOPE)({ "openai/session": "PRIVATE_CANARY" });
  expect(readFileSync(target, "utf8")).toBe(before);
});
