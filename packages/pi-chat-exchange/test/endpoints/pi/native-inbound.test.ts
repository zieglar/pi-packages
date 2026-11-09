import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeInbound } from "../../../pi-extension/native-inbound.js";

const outcome = (result: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }, isError = false) => ({
  toolCall: { type: "toolCall" as const, id: "nested-call", name: "ce_read", arguments: {} }, result, isError,
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "ce-inbound-")); roots.push(root); fs.chmodSync(root, 0o700);
  const policyPath = join(root, "real-A.json");
  let clock = Date.parse("2026-11-06T12:00:01Z"), session = "real-A";
  const policy = { version: 1, enabled: true, runtimeSessionId: "real-A", endpointId: "pi/A", exchangeId: "ex-1", from: "chatgpt/main",
    activatedAt: "2026-11-06T12:00:00Z", afterAuditSequence: 100, maxAgeSeconds: 300 };
  const save = (value: unknown = policy) => fs.writeFileSync(policyPath, JSON.stringify(value), { mode: 0o600 }); save();
  const text = "请检查项目状态，然后给出结果。";
  const metadata = { messageId: "msg_fresh", exchangeId: "ex-1", from: "chatgpt/main", to: "pi/A", state: "CREATED",
    createdAt: "2026-11-06T12:00:01Z", auditSequence: 101, payloadLength: Buffer.byteLength(text), payloadDigest: createHash("sha256").update(text).digest("hex") };
  const entries: Array<Record<string, unknown>> = [];
  const append = vi.fn((customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); });
  const listInbox = vi.fn((_input: { afterAuditSequence: number; pageSize: number; rawScanLimit: number }) => ({ messages: [{ messageId: metadata.messageId, auditSequence: metadata.auditSequence }], continuationAuditSequence: 101, scanBudgetExhausted: false }));
  const readMetadata = vi.fn(() => metadata);
  const wake = vi.fn();
  const executeTool = vi.fn(async (name: string) => outcome({ content: name === "ce_read_payload" ? [{ type: "text", text: "untrusted payload" }, { type: "text", text }] : [], details: { ...metadata } }));
  const create = () => createNativeInbound({ policyPath, runtimeSessionId: "real-A", endpointId: "pi/A", getSessionId: () => session,
    getEntries: () => entries, append, listInbox, readMetadata, wake, now: () => clock });
  return { policyPath, policy, save, metadata, entries, append, listInbox, readMetadata, wake, executeTool, create, text,
    setClock: (value: number) => { clock = value; }, switchSession: () => { session = "real-B"; } };
}

it("defaults disabled without a local policy and never checks Inbox", () => {
  const f = fixture(); fs.unlinkSync(f.policyPath); f.create().poll(); expect(f.listInbox).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
});
it("records a metadata-only claim before requesting one native follow-up", () => {
  const f = fixture(); const c = f.create(); c.poll(); c.poll();
  expect(f.listInbox).toHaveBeenCalledWith({ afterAuditSequence: 100, pageSize: 20, rawScanLimit: 200 });
  expect(f.wake).toHaveBeenCalledTimes(1); expect(f.append.mock.invocationCallOrder[0]).toBeLessThan(f.wake.mock.invocationCallOrder[0]!);
  expect(f.wake.mock.calls[0]![0]).toMatchObject({ messageId: "msg_fresh" });
  expect(JSON.stringify(f.entries) + JSON.stringify(f.wake.mock.calls)).not.toContain(f.text);
});
it("full append history prevents another wake after reload or branch rollback", () => {
  const f = fixture(); f.create().poll(); f.create().poll(); expect(f.wake).toHaveBeenCalledTimes(1);
});
it("an uncertain native wake is never retried", () => {
  const f = fixture(); f.wake.mockImplementation(() => { throw Error("private diagnostics"); });
  expect(() => f.create().poll()).toThrow("INBOUND_WAKE_UNKNOWN");
  f.wake.mockReset(); f.create().poll(); expect(f.wake).not.toHaveBeenCalled();
});
it("a failed claim append stops before waking", () => {
  const f = fixture(); f.append.mockImplementation(() => { throw Error("disk"); });
  expect(() => f.create().poll()).toThrow(); expect(f.wake).not.toHaveBeenCalled();
});
it.each([
  { from: "chatgpt/other" }, { to: "pi/B" }, { exchangeId: "ex-other" }, { auditSequence: 100 },
  { createdAt: "2026-11-06T11:59:59Z" }, { createdAt: "2026-11-06T12:00:02Z" },
])("does not wake a message outside the authorized activation: %j", patch => {
  const f = fixture(); Object.assign(f.metadata, patch); f.create().poll(); expect(f.wake).not.toHaveBeenCalled();
});
it("does not wake a stale message", () => {
  const f = fixture(); f.setClock(Date.parse("2026-11-06T12:05:02Z")); f.create().poll(); expect(f.wake).not.toHaveBeenCalled();
});
it.each([{ runtimeSessionId: "real-B" }, { endpointId: "pi/B" }, { maxAgeSeconds: 301 }, { activatedAt: "2026-11-06T12:00:02Z" }, { surprise: "execute-anything" }])("refuses invalid local policy %j", patch => {
  const f = fixture(); f.save({ ...f.policy, ...patch }); expect(() => f.create().poll()).toThrow("INBOUND_POLICY_INVALID"); expect(f.wake).not.toHaveBeenCalled();
});
it("refuses a public or symlink policy file", () => {
  const f = fixture(); fs.chmodSync(f.policyPath, 0o644); expect(() => f.create().poll()).toThrow("INBOUND_POLICY_INVALID");
  fs.renameSync(f.policyPath, f.policyPath + ".real"); fs.symlinkSync(f.policyPath + ".real", f.policyPath);
  expect(() => f.create().poll()).toThrow("INBOUND_POLICY_INVALID");
});
it("requires an actual wake claim before reading any task", async () => {
  const f = fixture(); await expect(f.create().receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_NOT_CLAIMED"); expect(f.executeTool).not.toHaveBeenCalled();
});
it("reads through both registered CE tools and exposes exact bytes once", async () => {
  const f = fixture(); const c = f.create(); c.poll();
  expect(await c.receive("msg_fresh", { executeTool: f.executeTool })).toEqual({ messageId: "msg_fresh", text: f.text, metadata: expect.objectContaining({ payloadDigest: f.metadata.payloadDigest }) });
  expect(f.executeTool.mock.calls.map(call => call[0])).toEqual(["ce_read", "ce_read_payload"]);
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_ALREADY_ATTEMPTED");
  await expect(f.create().receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_ALREADY_ATTEMPTED");
});
it("policy removal revokes an already queued wake before any registered read", async () => {
  const f = fixture(); const c = f.create(); c.poll(); fs.unlinkSync(f.policyPath);
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_DISABLED"); expect(f.executeTool).not.toHaveBeenCalled();
});
it("policy replacement cannot adopt a pending claim", async () => {
  const f = fixture(); const c = f.create(); c.poll(); f.save({ ...f.policy, maxAgeSeconds: 299 });
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_POLICY_CHANGED"); expect(f.executeTool).not.toHaveBeenCalled();
});
it.each(["policy", "session", "close"])("rechecks %s after an asynchronous registered read", async boundary => {
  const f = fixture(); const c = f.create(); c.poll();
  f.executeTool.mockImplementation(async () => {
    if (boundary === "policy") fs.unlinkSync(f.policyPath);
    if (boundary === "session") f.switchSession();
    if (boundary === "close") c.close();
    return outcome({ details: { ...f.metadata }, content: [] });
  });
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow(); expect(f.executeTool).toHaveBeenCalledTimes(1);
});
it("deferred delivery stays revoked after identical policy contents are restored", () => {
  const f = fixture(); const c = f.create(); c.poll();
  const token = f.wake.mock.calls[0]![0] as { policyDigest: string; policyRevision: string };
  const allowed = () => c.stillAuthorized(token.policyDigest, token.policyRevision);
  expect(allowed()).toBe(true);
  fs.unlinkSync(f.policyPath);
  expect(allowed()).toBe(false);
  f.save();
  expect(allowed()).toBe(false);
  f.metadata.messageId = "msg_new"; f.metadata.auditSequence = 102; c.poll();
  const fresh = f.wake.mock.calls.at(-1)![0] as { policyDigest: string; policyRevision: string };
  expect(c.stillAuthorized(fresh.policyDigest, fresh.policyRevision)).toBe(true);
  f.save();
  expect(c.stillAuthorized(fresh.policyDigest, fresh.policyRevision)).toBe(false);
  c.close();
  expect(allowed()).toBe(false);
});
it("propagates a registered permission refusal without exposing diagnostics or retrying", async () => {
  const f = fixture(); const c = f.create(); c.poll();
  f.executeTool.mockResolvedValue(outcome({ content: [{ type: "text", text: "private" }], details: {} }, true));
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_READ_REFUSED");
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_ALREADY_ATTEMPTED"); expect(f.executeTool).toHaveBeenCalledTimes(1);
});
it.each(["digest", "metadata", "shape"]) ("refuses corrupt nested payload %s", async corruption => {
  const f = fixture(); const c = f.create(); c.poll();
  f.executeTool.mockImplementation(async name => outcome({ details: { ...f.metadata, ...(corruption === "metadata" && name === "ce_read_payload" ? { from: "wrong" } : {}) },
    content: name === "ce_read_payload" ? [{ type: "text", text: "header" }, ...(corruption === "shape" ? [] : [{ type: "text" as const, text: corruption === "digest" ? "wrong" : f.text }])] : [] }));
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow();
});
it("parallel receive attempts cannot both cross the registered read boundary", async () => {
  const f = fixture(); const c = f.create(); c.poll(); const first = c.receive("msg_fresh", { executeTool: f.executeTool });
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_ALREADY_ATTEMPTED"); await first;
  expect(f.executeTool).toHaveBeenCalledTimes(2);
});
it("a changed Session and closed controller cannot poll", () => {
  const f = fixture(); const c = f.create(); f.switchSession(); expect(() => c.poll()).toThrow("INBOUND_SESSION_CHANGED");
  const other = fixture(); const stopped = other.create(); stopped.close(); expect(() => stopped.poll()).toThrow("INBOUND_CLOSED");
  expect(f.wake).not.toHaveBeenCalled(); expect(other.wake).not.toHaveBeenCalled();
});

it("disabled local policy also revokes queued reads", async () => {
  const f = fixture(); const c = f.create(); c.poll(); f.save({ ...f.policy, enabled: false });
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_DISABLED");
  expect(f.executeTool).not.toHaveBeenCalled();
});
it("follows a bounded audit continuation across ticks even when a scan finds no messages", () => {
  const f = fixture(); const c = f.create();
  f.listInbox.mockReturnValueOnce({ messages: [], continuationAuditSequence: 150, scanBudgetExhausted: true });
  c.poll(); c.poll();
  expect(f.listInbox).toHaveBeenCalledTimes(2);
  expect(f.listInbox.mock.calls[1]?.[0]).toEqual({ afterAuditSequence: 150, pageSize: 20, rawScanLimit: 200 });
});
it("refuses malformed append-history records", () => {
  const f = fixture(); f.entries.push({ type: "custom", customType: "ce-inbound-wake", data: null });
  expect(() => f.create().poll()).toThrow("INBOUND_HISTORY_INVALID"); expect(f.wake).not.toHaveBeenCalled();
});
it("a policy change during a registered read blocks the payload call", async () => {
  const f = fixture(); const c = f.create(); c.poll();
  f.executeTool.mockImplementation(async () => { f.save({ ...f.policy, maxAgeSeconds: 299 }); return outcome({ details: f.metadata, content: [] }); });
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_POLICY_CHANGED");
  expect(f.executeTool).toHaveBeenCalledTimes(1);
});
it("rechecks revocation after the actual payload has returned", async () => {
  const f = fixture(); const c = f.create(); c.poll();
  f.executeTool.mockImplementation(async name => {
    if (name === "ce_read_payload") fs.unlinkSync(f.policyPath);
    return outcome({ details: f.metadata, content: name === "ce_read_payload" ? [{ type: "text", text: "header" }, { type: "text", text: f.text }] : [] });
  });
  await expect(c.receive("msg_fresh", { executeTool: f.executeTool })).rejects.toThrow("INBOUND_DISABLED");
});
it("a fresh admitted task can wait while the Agent is busy without becoming a new stale intake", async () => {
  const f = fixture(); const c = f.create(); c.poll(); f.setClock(Date.parse("2026-11-06T12:10:01Z"));
  expect(await c.receive("msg_fresh", { executeTool: f.executeTool })).toMatchObject({ text: f.text });
});
