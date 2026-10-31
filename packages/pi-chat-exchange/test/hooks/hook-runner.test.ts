import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CE_MESSAGE_COMMITTED_EVENT, type CeCommittedMessageEvent } from "../../src/hooks/events.js";
import { parseHookRules } from "../../src/hooks/config.js";
import { CeHookRunner } from "../../src/hooks/runner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "ce-hook-runner-"));
  roots.push(directory);
  return directory;
}

function event(recipient = { adapter: "pi", endpointId: "pi/main" }, suffix = "1"): CeCommittedMessageEvent {
  return {
    schemaVersion: 1,
    event: CE_MESSAGE_COMMITTED_EVENT,
    eventId: `evt_01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
    eventKey: `ho_01ARZ3NDEKTSV4RRFFQ69G5FA0/${suffix}`,
    messageId: `msg_01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`,
    exchangeId: "ho_01ARZ3NDEKTSV4RRFFQ69G5FA0",
    sender: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipient,
    createdAt: "2026-10-10T00:00:00.000Z",
    payloadDigest: "a".repeat(64),
    payloadLength: 7,
  };
}

function notifyScript(directory: string): string {
  const path = join(directory, "notify.mjs");
  writeFileSync(path, `import { readFileSync, writeFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\nwriteFileSync(process.argv[2], JSON.stringify(input));\nprocess.stdout.write("HOOK_STDOUT_SECRET");\nprocess.stderr.write("HOOK_STDERR_SECRET");\n`);
  return path;
}

function records(directory: string): Array<Record<string, unknown>> {
  const path = join(directory, "ce-hooks", "executions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

describe("real local Hook Runner", () => {
  it("executes only the exact recipient with a metadata-only UTF-8 envelope and no output leakage", async () => {
    const directory = root();
    const script = notifyScript(directory);
    const output = join(directory, "event.json");
    const unmatched = join(directory, "unmatched.json");
    const runner = new CeHookRunner({
      directory,
      rules: parseHookRules([
        { id: "pi", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [script, output] },
        { id: "other", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: process.execPath, args: [script, unmatched] },
      ]),
    });
    const injected = join(directory, "remote-command-injected");
    const unsafe = { ...event(), payloadText: `$(touch ${injected}) PAYLOAD_SECRET`, capability: "CAPABILITY_SECRET", command: "/bin/sh", args: ["-c", `touch ${injected}`] } as CeCommittedMessageEvent;
    runner.publish(unsafe);
    await runner.close();

    const envelope = JSON.parse(readFileSync(output, "utf8"));
    expect(envelope).toMatchObject({ event: CE_MESSAGE_COMMITTED_EVENT, messageId: event().messageId, recipient: { adapter: "pi", endpointId: "pi/main" }, payloadLength: 7 });
    expect(existsSync(unmatched)).toBe(false);
    expect(readFileSync(output, "utf8")).not.toContain("PAYLOAD_SECRET");
    expect(existsSync(injected)).toBe(false);
    expect(readFileSync(output, "utf8")).not.toContain("CAPABILITY_SECRET");
    const rawRecords = readFileSync(join(directory, "ce-hooks", "executions.jsonl"), "utf8");
    expect(rawRecords).not.toContain("PAYLOAD_SECRET");
    expect(rawRecords).not.toContain("HOOK_STDOUT_SECRET");
    expect(rawRecords).not.toContain("HOOK_STDERR_SECRET");
    expect(records(directory).filter(row => row.status === "SUCCEEDED")).toHaveLength(1);
  });

  it("starts a new drain after a previous batch has become idle", async () => {
    const directory = root();
    const output = join(directory, "event.json");
    const runner = new CeHookRunner({ directory, rules: parseHookRules([{ id: "repeat", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [notifyScript(directory), output] }]) });
    try {
      runner.publish(event());
      await vi.waitFor(() => expect(records(directory).filter(row => row.status === "SUCCEEDED")).toHaveLength(1));
      runner.publish(event(undefined, "2"));
      await vi.waitFor(() => expect(records(directory).filter(row => row.status === "SUCCEEDED")).toHaveLength(2));
      expect(JSON.parse(readFileSync(output, "utf8")).messageId).toBe(event(undefined, "2").messageId);
    } finally { await runner.close(); }
  });


  it.each([
    { label: "nonzero", status: "FAILED", exitCode: 7, script: "process.exit(7)", timeoutMs: 5000 },
    { label: "timeout", status: "TIMEOUT", exitCode: null, script: "setTimeout(() => {}, 10000)", timeoutMs: 1000 },
  ])("records one $label result without retry", async ({ status, exitCode, script, timeoutMs }) => {
    const directory = root();
    const path = join(directory, "failure.mjs");
    writeFileSync(path, script);
    const runner = new CeHookRunner({ directory, rules: parseHookRules([{ id: "failure", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [path], timeoutMs }]) });
    runner.publish(event());
    await runner.close();
    const rows = records(directory);
    expect(rows.filter(row => row.status === "STARTED")).toHaveLength(1);
    const finished = rows.find(row => row.status === status);
    expect(finished).toMatchObject({ hookId: "failure", messageId: event().messageId, status, exitCode });
    expect(finished).toHaveProperty("startedAt");
    expect(finished).toHaveProperty("finishedAt");
    if (status === "TIMEOUT") expect(finished).toMatchObject({ timeout: true });
  });

  it("records an invalid executable as SPAWN_FAILED without throwing into the caller", async () => {
    const directory = root();
    const runner = new CeHookRunner({ directory, rules: parseHookRules([{ id: "missing", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: join(directory, "missing", "node") }]) });
    expect(() => runner.publish(event())).not.toThrow();
    await runner.close();
    expect(records(directory).some(row => row.status === "SPAWN_FAILED" && row.hookId === "missing")).toBe(true);
  });

  it("bounds queued work and records overflow instead of creating unlimited children", async () => {
    const directory = root();
    const path = join(directory, "slow.mjs");
    writeFileSync(path, "setTimeout(() => {}, 10000)");
    const runner = new CeHookRunner({ directory, rules: parseHookRules([{ id: "slow", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [path], timeoutMs: 1000 }]) });
    for (let index = 0; index < 40; index += 1) runner.publish(event(undefined, String(index).padStart(2, "0")));
    await runner.close();
    const rows = records(directory);
    expect(rows.filter(row => row.status === "STARTED").length).toBeLessThanOrEqual(1);
    expect(rows.filter(row => row.status === "SKIPPED_QUEUE_FULL").length).toBeGreaterThan(0);
    expect(rows.filter(row => row.status === "SKIPPED_SHUTDOWN").length).toBeGreaterThan(0);
  });
  it("keeps disabled and unmatched rules inert and isolates unavailable execution records", async () => {
    const directory = root();
    const script = notifyScript(directory);
    const output = join(directory, "event.json");
    const rule = { id: "notify", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [script, output] };
    const inert = new CeHookRunner({ directory, rules: parseHookRules([{ ...rule, enabled: false }]) });
    inert.publish(event());
    await inert.close();
    expect(existsSync(output)).toBe(false);
    expect(records(directory)).toEqual([]);
    const runner = new CeHookRunner({ directory, rules: parseHookRules([rule]) });
    try {
      runner.publish(event({ adapter: "pi", endpointId: "pi/other" }));
      expect(existsSync(output)).toBe(false);
      expect(records(directory)).toEqual([]);
      writeFileSync(join(directory, "ce-hooks"), "unavailable audit directory");
      expect(() => runner.publish(event())).not.toThrow();
      await vi.waitFor(() => expect(existsSync(output)).toBe(true));
    } finally { await runner.close(); }
    expect(JSON.parse(readFileSync(output, "utf8")).messageId).toBe(event().messageId);
  });

  it("rechecks policy before queued execution and reports only effective active rules", async () => {
    const directory = root();
    const output = join(directory, "event.json");
    let allowed = true;
    const rule = parseHookRules([{ id: "gated", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [notifyScript(directory), output] }])[0]!;
    const runner = new CeHookRunner({ directory, rules: [rule], admit: () => allowed });
    try {
      runner.publish(event());
      await vi.waitFor(() => expect(records(directory).some(row => row.status === "SUCCEEDED")).toBe(true));
      allowed = false;
      expect(runner.snapshot().active).toBe(0);
      runner.publish(event(undefined, "2"));
      await vi.waitFor(() => expect(records(directory).some(row => row.status === "SKIPPED_POLICY_DENIED")).toBe(true));
      expect(JSON.parse(readFileSync(output, "utf8")).messageId).toBe(event().messageId);
    } finally { await runner.close(); }
  });

  it("denies a queued item revoked while the earlier direct child was active", async () => {
    const directory = root();
    const started = join(directory, "started");
    const finish = join(directory, "finish");
    const script = join(directory, "wait.mjs");
    writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(process.argv[2], "started"); const timer=setInterval(() => { if(fs.existsSync(process.argv[3])) { clearInterval(timer); process.exit(0); } }, 10);`);
    let allowed = true;
    const rule = parseHookRules([{ id: "queued", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: process.execPath, args: [script, started, finish], timeoutMs: 5000 }])[0]!;
    const runner = new CeHookRunner({ directory, rules: [rule], admit: () => allowed });
    try {
      runner.publish(event());
      await vi.waitFor(() => expect(existsSync(started)).toBe(true));
      runner.publish(event(undefined, "2"));
      allowed = false;
      writeFileSync(finish, "done");
      await vi.waitFor(() => expect(records(directory).some(row => row.status === "SKIPPED_POLICY_DENIED")).toBe(true));
      expect(records(directory).filter(row => row.status === "STARTED")).toHaveLength(1);
    } finally { writeFileSync(finish, "done"); await runner.close(); }
  });

});
