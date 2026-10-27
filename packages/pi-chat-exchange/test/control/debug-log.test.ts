import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDebugLog, argumentShape, errorSummary } from "../../src/control/debug-log.js";

const dirs: string[] = [];
function fixture() { const d = mkdtempSync(join(tmpdir(), "ce-debug-test-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it("writes private JSONL with identity and allowlisted context, never secrets or raw input", () => {
  const dir = fixture(); const log = createDebugLog(dir);
  log("test", "SERVER_ENTRY", { stage: "entry", token: "SECRET_CANARY", payload: "BODY_CANARY", pid: 999 } as never);
  const raw = readFileSync(join(dir, `ce-debug-${process.pid}.jsonl`), "utf8");
  const row = JSON.parse(raw.trim());
  expect(row).toMatchObject({ pid: process.pid, component: "test", event: "SERVER_ENTRY", stage: "entry" });
  expect(new Date(row.ts).toISOString()).toBe(row.ts);
  expect(raw).not.toMatch(/SECRET_CANARY|BODY_CANARY/);
  expect(statSync(join(dir, `ce-debug-${process.pid}.jsonl`)).mode & 0o777).toBe(0o600);
});
it("logging remains nonthrowing when its directory is a file or destination is a symlink", () => {
  const dir = fixture(); const file = join(dir, "not-dir"); writeFileSync(file, "unchanged");
  expect(() => createDebugLog(file)("test", "SERVER_ENTRY")).not.toThrow();
  symlinkSync(file, join(dir, `ce-debug-${process.pid}.jsonl`));
  expect(() => createDebugLog(dir)("test", "SERVER_ENTRY")).not.toThrow();
  expect(readFileSync(file, "utf8")).toBe("unchanged");
});
it("argument summaries omit values and untrusted property names", () => {
  const summary = argumentShape({ text: "BODY_CANARY", to: "SECRET_CANARY", SECRET_FIELD_CANARY: "secret", pageSize: 2 });
  expect(JSON.stringify(summary)).not.toMatch(/BODY_CANARY|SECRET_CANARY|SECRET_FIELD_CANARY/);
  expect(summary).toContainEqual({ field: "text", type: "string", length: 11 });
});
it("error summaries omit message and stack-header secrets but retain safe frame locations", () => {
  const e = new Error("SECRET_CANARY"); e.stack = "Error: SECRET_CANARY\n    at fn (/isolated/file.js:10:20)\n    at BODY_CANARY (SECRET_CANARY)";
  expect(JSON.stringify(errorSummary(e))).not.toMatch(/SECRET_CANARY|BODY_CANARY/);
  expect(errorSummary(e)).toMatchObject({ errorType: "Error", stackFrames: ["file.js:10:20"] });
});
