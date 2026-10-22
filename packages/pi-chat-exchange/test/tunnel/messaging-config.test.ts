import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiAllowlistDocument, piAllowlistPath, publishMessagingPair, readMessagingPair, type PiSideConfigInput } from "../../dist/tunnel/messaging-config.js";
import { ensureManagedBinding } from "../../dist/tunnel/managed-binding.js";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-immutable-pair-")); dirs.push(dir);
  const profile = join(dir, "tunnel.yaml");
  const managed = ensureManagedBinding(profile, { tunnelId: "tunnel_abcdefgh123456", organizationId: "org-old", adapter: "chatgpt",
    endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/main" }], capabilities: { payloadRead: true, ack: true } });
  const input: PiSideConfigInput = { chatgptEndpoint: managed.config.endpoint, piEndpoint: { adapter: "pi", endpointId: "pi/main" },
    piSessionId: "runtime-session", exchangeNamespace: managed.config.exchange.namespace,
    exchangeIdempotencyKey: managed.config.exchange.idempotencyKey, store: managed.config.store, payloadRead: true, ack: true };
  return { dir, profile, config: managed.config, input };
}
describe("immutable messaging configuration pairs", () => {
  it("builds a single-session reciprocal policy with no debug or inbox grant", () => {
    const f = fixture(); const doc = buildPiAllowlistDocument(f.input);
    expect(doc.sessions).toEqual({ "runtime-session": { endpointId: "pi/main" } });
    expect(doc.recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);
    expect(doc.payloadRead).toEqual({ enabled: true }); expect(doc.ack).toEqual({ enabled: true });
    expect(doc.store).toEqual(f.config.store); expect(doc.inboxNotification).toBeUndefined(); expect(doc.debugExecutionGuard).toBeUndefined();
  });
  it.each(["session", "endpoint", "store"])("refuses credential-shaped %s labels", (kind) => {
    const f = fixture();
    const input = kind === "session" ? { ...f.input, piSessionId: "cap_0123456789abcdef" } : kind === "endpoint"
      ? { ...f.input, piEndpoint: { adapter: "pi", endpointId: "cap_0123456789abcdef" } }
      : { ...f.input, store: { directory: "/abs/cap_0123456789abcdef", file: "ce-store.sqlite" } };
    expect(() => buildPiAllowlistDocument(input)).toThrow();
  });
  it("publishes two immutable 0600 files without writing the legacy user allowlist", () => {
    const f = fixture(); const user = piAllowlistPath(f.profile); const original = Buffer.from([0xff, 0xfe, 0x7b]);
    fs.writeFileSync(user, original, { mode: 0o600 });
    const pair = publishMessagingPair(f.profile, f.config, f.input);
    expect(pair.durability).toBe("synced");
    expect(pair.allowlistPath).toBe(`${pair.bindingPath}.pi-allowlist.json`);
    expect(pair.allowlistPath).not.toBe(user);
    expect(fs.readFileSync(user)).toEqual(original);
    expect(fs.lstatSync(pair.bindingPath).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(pair.allowlistPath).mode & 0o777).toBe(0o600);
    expect(readMessagingPair(f.profile, pair.bindingPath)?.document.sessions).toEqual({ "runtime-session": { endpointId: "pi/main" } });
    expect(fs.existsSync(join(f.config.store.directory, f.config.store.file))).toBe(false);
  });
  it("reuses the exact generation without rewriting and gives a different session a different pair", () => {
    const f = fixture(); const first = publishMessagingPair(f.profile, f.config, f.input);
    const identity = fs.lstatSync(first.bindingPath); const old = fs.readFileSync(first.allowlistPath);
    const again = publishMessagingPair(f.profile, f.config, f.input);
    expect(again.bindingPath).toBe(first.bindingPath); expect(fs.lstatSync(again.bindingPath).ino).toBe(identity.ino);
    const next = publishMessagingPair(f.profile, f.config, { ...f.input, piSessionId: "next-session" });
    expect(next.bindingPath).not.toBe(first.bindingPath); expect(fs.readFileSync(first.allowlistPath)).toEqual(old);
  });
  it("rejects a mismatched binding/policy before publishing", () => {
    const f = fixture(); const before = fs.readdirSync(f.config.store.directory);
    expect(() => publishMessagingPair(f.profile, f.config, { ...f.input, exchangeIdempotencyKey: "different" })).toThrow();
    expect(fs.readdirSync(f.config.store.directory)).toEqual(before);
  });
  it("fails closed if immutable bytes no longer match their generation digest", () => {
    const f = fixture(); const pair = publishMessagingPair(f.profile, f.config, f.input);
    fs.writeFileSync(pair.allowlistPath, "{}");
    expect(() => readMessagingPair(f.profile, pair.bindingPath)).toThrow();
  });
});
