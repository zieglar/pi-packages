import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../src/hooks/events.js";
import { parseHookRules } from "../../src/hooks/config.js";
import { CeHookRunner } from "../../src/hooks/runner.js";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";

const NOW = "2026-10-10T00:00:00.000Z";
const CHATGPT = "chatgpt/main";
const PI = "pi/main";
const roots: string[] = [];
afterEach(() => {
  cleanupFixtures();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function notifications(path: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("real CE Store + Hook Runner two-way acceptance", () => {
  it("routes ChatGPT/Pi independently without changing payload, replay, failed commit or ACK semantics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ce-hook-two-way-"));
    roots.push(directory);
    const script = join(directory, "notify.mjs");
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";\nconst event = JSON.parse(readFileSync(0, "utf8"));\nconst path = process.argv[2];\nlet rows = [];\ntry { rows = JSON.parse(readFileSync(path, "utf8")); } catch {}\nrows.push(event);\nwriteFileSync(path, JSON.stringify(rows));\nprocess.stdout.write("HOOK_STDOUT_MARKER");\nprocess.stderr.write("HOOK_STDERR_MARKER");\n`);
    const failing = join(directory, "fail.mjs");
    writeFileSync(failing, "process.exit(9)");
    const piOutput = join(directory, "pi-notified.json");
    const chatgptOutput = join(directory, "chatgpt-notified.json");
    const chatgptRunner = new CeHookRunner({
      directory,
      rules: parseHookRules([
        { id: "hook-a", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: PI }, command: process.execPath, args: [script, piOutput] },
        { id: "hook-failure", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: PI }, command: process.execPath, args: [failing] },
      ]),
    });
    const piRunner = new CeHookRunner({
      directory,
      rules: parseHookRules([{ id: "hook-b", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "chatgpt", endpointId: CHATGPT }, command: process.execPath, args: [script, chatgptOutput] }]),
    });
    const fx = fixture("ce-hook-two-way-store-");
    const chatgpt = new CeEndpointHost(fx.store, {
      adapter: "chatgpt", exchangeNamespace: "ce-hook-two-way", exchangeIdempotencyKey: "exchange-1",
      allowlist: [{ endpointId: CHATGPT }], recipients: [{ adapter: "pi", endpointId: PI }],
      payloadRead: { enabled: true }, ack: { enabled: true }, now: () => NOW,
      onMessageCommitted: event => chatgptRunner.publish(event),
    });
    const pi = new CeEndpointHost(fx.store, {
      adapter: "pi", exchangeNamespace: "ce-hook-two-way", exchangeIdempotencyKey: "exchange-1",
      allowlist: [{ endpointId: PI }], recipients: [{ adapter: "chatgpt", endpointId: CHATGPT }],
      payloadRead: { enabled: true }, ack: { enabled: true }, now: () => NOW,
      onMessageCommitted: event => piRunner.publish(event),
    });
    chatgpt.beginSession(CHATGPT);
    pi.beginSession(PI);
    const payload = "# 双向 🚀\r\n\r\n  indented\ntrailing  \n```ts\nconst x = \"😀\";\n```";

    try {
      const outbound = chatgpt.send(CHATGPT, { to: PI, text: payload, idempotencyKey: "chatgpt-to-pi" });
      await waitForFile(piOutput);
      expect(existsSync(chatgptOutput)).toBe(false);
      expect(notifications(piOutput)).toHaveLength(1);
      expect(notifications(piOutput)[0]).toMatchObject({ event: CE_MESSAGE_COMMITTED_EVENT, messageId: outbound.messageId, sender: { adapter: "chatgpt", endpointId: CHATGPT }, recipient: { adapter: "pi", endpointId: PI } });
      expect(JSON.stringify(notifications(piOutput))).not.toContain("双向");

      const inbound = pi.send(PI, { to: CHATGPT, text: "Pi → ChatGPT ✓", idempotencyKey: "pi-to-chatgpt" });
      await waitForFile(chatgptOutput);
      expect(notifications(chatgptOutput)).toHaveLength(1);
      expect(notifications(chatgptOutput)[0]).toMatchObject({ messageId: inbound.messageId, sender: { adapter: "pi", endpointId: PI }, recipient: { adapter: "chatgpt", endpointId: CHATGPT } });

      const read = pi.readPayload(PI, { messageId: outbound.messageId });
      expect(read.payloadText).toBe(payload);
      const bytes = new TextEncoder().encode(payload);
      expect(read.payloadLength).toBe(bytes.byteLength);
      expect(read.payloadDigest).toBe(createHash("sha256").update(bytes).digest("hex"));
      const raw = fx.store.database.prepare("SELECT payload_body FROM message WHERE message_id=?").get(outbound.messageId)!.payload_body;
      expect(Buffer.compare(Buffer.from(raw as Uint8Array), Buffer.from(bytes))).toBe(0);
      const ack = pi.acknowledge(PI, { messageId: outbound.messageId, payloadDigest: read.payloadDigest, payloadLength: read.payloadLength, messageCreatedAuditSequence: read.auditSequence });
      expect(ack.disposition).toBe("CREATED");

      expect(chatgpt.send(CHATGPT, { to: PI, text: payload, idempotencyKey: "chatgpt-to-pi" }).disposition).toBe("REPLAYED");
      expect(pi.send(PI, { to: CHATGPT, text: "Pi → ChatGPT ✓", idempotencyKey: "pi-to-chatgpt" }).disposition).toBe("REPLAYED");

      const exec = fx.store.database.exec.bind(fx.store.database);
      fx.store.database.exec = (sql: string) => {
        if (sql.includes("COMMIT")) throw new Error("injected rollback commit failure");
        return exec(sql);
      };
      expect(() => chatgpt.send(CHATGPT, { to: PI, text: "no notification", idempotencyKey: "failed-commit" })).toThrow();
      fx.store.database.exec = exec;
      await vi.waitFor(() => {
        const rows = readFileSync(join(directory, "ce-hooks", "executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows.some(row => row.hookId === "hook-failure" && row.status === "FAILED" && row.exitCode === 9)).toBe(true);
      }, { timeout: 5000 });
    } finally {
      await Promise.all([chatgptRunner.close(), piRunner.close()]);
    }

    expect(notifications(piOutput)).toHaveLength(1);
    expect(notifications(chatgptOutput)).toHaveLength(1);
    const logPath = join(directory, "ce-hooks", "executions.jsonl");
    const log = readFileSync(logPath, "utf8");
    expect(log).not.toContain("双向");
    expect(log).not.toContain("HOOK_STDOUT_MARKER");
    expect(log).not.toContain("HOOK_STDERR_MARKER");
    const rows = log.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.some(row => row.hookId === "hook-failure" && row.status === "FAILED" && row.exitCode === 9)).toBe(true);
    expect(rows.filter(row => row.hookId === "hook-a" && row.status === "STARTED")).toHaveLength(1);
    expect(rows.filter(row => row.hookId === "hook-b" && row.status === "STARTED")).toHaveLength(1);
  });
});
