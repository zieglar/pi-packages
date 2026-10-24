import fs from "node:fs";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { multiSessionFixture } from "../../tunnel/support/multi-session-fixture.js";
import { initializeStore } from "../../../dist/storage/store.js";

type Reply = { result: any; notices: string[]; error?: string };
function peer(session: string, profile: string, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const child = fork(resolve("test/tunnel/support/composed-extension-worker.mjs"), [session], {
    execPath: process.execPath, execArgv: ["--import", resolve("test/tunnel/support/composed-extension-register.mjs")],
    env: { PATH: process.env.PATH!, HOME: dir, PI_CODING_AGENT_DIR: dir, CE_TUNNEL_PROFILE: profile,
      CE_ALLOWLIST: "", CE_STORE_DIR: "", CE_STORE_FILE: "", CE_LEASE_TTL_SECONDS: "", CE_TUNNEL_OFFLINE_TEST: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr!.on("data", b => { diagnostics += String(b); });
  child.stdout!.on("data", b => { diagnostics += String(b); });
  let sequence = 0;
  const waiting = new Map<number, { resolve(value: Reply): void; reject(error: Error): void }>();
  let readyResolve!: (value: { pid: number; node: string }) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<{ pid: number; node: string }>((res, rej) => { readyResolve = res; readyReject = rej; });
  const readyDeadline = setTimeout(() => readyReject(new Error(`synthetic ${session} readiness timeout: ${diagnostics}`)), 10_000);
  child.on("message", (raw: any) => {
    if (raw.ready) { clearTimeout(readyDeadline); readyResolve(raw); return; }
    const pending = waiting.get(raw.id); waiting.delete(raw.id);
    if (raw.error) pending?.reject(new Error(raw.error)); else pending?.resolve(raw);
  });
  const exited = new Promise<void>(res => child.once("exit", (code, signal) => {
    const error = new Error(`synthetic ${session} exited ${code}/${signal}: ${diagnostics}`);
    clearTimeout(readyDeadline); readyReject(error); for (const pending of waiting.values()) pending.reject(error); waiting.clear(); res();
  }));
  child.on("error", error => { clearTimeout(readyDeadline); readyReject(error); for (const pending of waiting.values()) pending.reject(error); });
  function request(operation: string, fields: Record<string, unknown> = {}): Promise<Reply> {
    return new Promise((res, rej) => {
      const id = ++sequence;
      const deadline = setTimeout(() => { waiting.delete(id); rej(new Error(`synthetic ${session} IPC timeout at ${operation}: ${diagnostics}`)); }, 10_000);
      const reject = (error: Error) => { clearTimeout(deadline); rej(error); };
      waiting.set(id, { resolve: value => { clearTimeout(deadline); res(value); }, reject });
      child.send({ id, operation, ...fields }, error => { if (error) { waiting.delete(id); reject(error); } });
    });
  }
  return { ready, child, request, tool: (name: string, input: unknown = {}) => request("tool", { name, input }),
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000); // synthetic worker only; failure cleanup watchdog, not coordination
      try { if (child.connected) await request("exit"); await exited; } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    } };
}

it("composes independent Pi factory OS processes, current-policy gates and fixed-sender MCP with independent durable evidence", { timeout: 60_000 }, async () => {
  expect(["v24.21.0", "v24.22.1"]).toContain(process.version);
  const f = await multiSessionFixture();
  const peers: ReturnType<typeof peer>[] = [];
  let client: Client | undefined; let transport: StdioClientTransport | undefined;
  const spawn = (id: string) => { const p = peer(id, f.profilePath, join(f.dir, `pi-state-${peers.length}`)); peers.push(p); return p; };
  try {
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: true, ack: true } });
    const loaded = f.selected();
    // Operator setup creates the shared Store once, before independent runtimes open it.
    initializeStore({ directory: loaded.config.store.directory, filename: loaded.config.store.file }).close();
    expect(fs.realpathSync(loaded.config.store.directory)).toBe(loaded.config.store.directory);
    // Every observation opens a separate read-only SQLite connection: no Host response is durable evidence.
    const rows = (sql: string, ...args: (string | number)[]) => {
      const db = new DatabaseSync(join(loaded.config.store.directory, loaded.config.store.file), { readOnly: true });
      try { return db.prepare(sql).all(...args); } finally { db.close(); }
    };
    const snapshot = () => Object.fromEntries(["message", "delivery_ack_receipt", "audit_event", "participant", "participant_session", "participant_ownership", "participant_fencing_high_water", "participant_capability", "exchange_membership", "delivery_cursor"].map(table => [table, rows(`SELECT * FROM ${table} ORDER BY rowid`)]));
    const a = spawn("real-A"), b = spawn("real-B"), c = spawn("real-C");
    const identities = await Promise.all([a.ready, b.ready, c.ready]);
    expect(new Set([process.pid, ...identities.map(x => x.pid)]).size).toBe(4);
    for (const [index, id] of identities.entries()) { expect(id.node).toBe(process.version); expect(id.pid).toBe([a, b, c][index]!.child.pid); }
    console.info("synthetic process identities", { parent: process.pid, workers: identities });
    const starts = await Promise.all([a.request("start"), b.request("start")]);
    console.info("synthetic start diagnostics", starts);
    const mapping = async (p: typeof a) => (await p.request("inspect")).result.entries.findLast((e: any) => e.customType === "ce-mapping")?.data;
    const ma = await mapping(a), mb = await mapping(b);
    const assertOwner = (m: any) => {
      expect(rows("SELECT * FROM participant WHERE participant_id=?", m.participantId)[0]).toMatchObject({ endpoint_adapter: "pi", endpoint_id: m.endpointId });
      expect(rows("SELECT * FROM participant_ownership WHERE participant_id=?", m.participantId)).toEqual([expect.objectContaining({ session_id: m.sessionId })]);
      expect(rows("SELECT * FROM participant_session WHERE participant_id=? AND session_id=?", m.participantId, m.sessionId)).toEqual([expect.objectContaining({ detached_at: null })]);
      expect(rows("SELECT * FROM exchange_membership WHERE participant_id=? AND exchange_id=?", m.participantId, m.exchangeId)).toHaveLength(1);
    };
    expect(ma).toMatchObject({ endpointId: "pi/A" }); expect(mb).toMatchObject({ endpointId: "pi/B" });
    expect(ma.participantId).not.toBe(mb.participantId); expect(ma.sessionId).not.toBe(mb.sessionId);
    assertOwner(ma); assertOwner(mb);
    const bAuthority = () => ({ owner: rows("SELECT * FROM participant_ownership WHERE participant_id=?", mb.participantId), session: rows("SELECT * FROM participant_session WHERE participant_id=?", mb.participantId), fence: rows("SELECT * FROM participant_fencing_high_water WHERE participant_id=?", mb.participantId) });
    const stableB = bAuthority();
    const duplicateBefore = snapshot();
    const duplicate = spawn("real-A"); const duplicateIdentity = await duplicate.ready;
    expect(identities.map(x => x.pid)).not.toContain(duplicateIdentity.pid); console.info("synthetic duplicate pid", duplicateIdentity.pid);
    await duplicate.request("start", { reason: "resume" });
    expect((await duplicate.tool("ce_inbox_list")).result.isError).toBe(true);
    expect(await mapping(duplicate)).toBeUndefined(); expect(snapshot()).toEqual(duplicateBefore);
    await duplicate.close();

    transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/bin/mcp-stdio.js"), "--config", loaded.bindingPath], stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: f.dir, PI_CODING_AGENT_DIR: join(f.dir, "mcp-state"), CE_TUNNEL_PROFILE: f.profilePath } });
    transport.stderr?.on("data", () => {});
    client = new Client({ name: "composed-synthetic", version: "1" }); await client.connect(transport);
    expect(transport.pid).toBeGreaterThan(0); expect(transport.pid).not.toBe(duplicateIdentity.pid); expect(transport.pid).not.toBe(process.pid); expect(identities.map(x => x.pid)).not.toContain(transport.pid);
    console.info("synthetic MCP pid", transport.pid);
    const mcp = (name: string, input: Record<string, unknown> = {}) => client!.callTool({ name, arguments: input });
    const sendChat = async (to: string, key: string) => {
      const response = await mcp("ce_send", { to, text: `ChatGPT → ${to} 🌱`, idempotencyKey: key });
      expect(response.isError).not.toBe(true); return (response.structuredContent as { messageId: string }).messageId;
    };
    const messageEvidence = (id: string, from: string, to: string, text: string) => {
      const evidence = rows("SELECT * FROM message WHERE message_id=?", id); expect(evidence).toHaveLength(1);
      const m = evidence[0]!; expect(JSON.parse(String(m.from_endpoint_json))).toEqual({ adapter: from.startsWith("pi/") ? "pi" : "chatgpt", endpointId: from });
      expect(JSON.parse(String(m.to_endpoint_json))).toEqual({ adapter: to.startsWith("pi/") ? "pi" : "chatgpt", endpointId: to });
      expect(Buffer.from(m.payload_body as Uint8Array)).toEqual(Buffer.from(text));
      expect(m.payload_length).toBe(Buffer.byteLength(text)); expect(m.payload_digest).toBe(createHash("sha256").update(text).digest("hex"));
      const audit = rows("SELECT * FROM audit_event WHERE kind='message_created' AND subject_id=?", id); expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ exchange_id: m.exchange_id, digest: m.payload_digest, length: m.payload_length });
      return { messageId: id, payloadDigest: m.payload_digest, payloadLength: m.payload_length, messageCreatedAuditSequence: audit[0]!.sequence };
    };
    const ackEvidence = (input: ReturnType<typeof messageEvidence>, owner: any) => {
      const receipt = rows("SELECT * FROM delivery_ack_receipt WHERE message_id=?", input.messageId); expect(receipt).toHaveLength(1);
      const r = receipt[0]!;
      expect(r).toMatchObject({ recipient_participant_id: owner.participantId, ack_session_id: owner.sessionId, payload_digest: input.payloadDigest, payload_length: input.payloadLength, message_created_audit_seq: input.messageCreatedAuditSequence });
      const ownership = rows("SELECT * FROM participant_ownership WHERE participant_id=?", owner.participantId)[0]!;
      expect(r.ack_fencing_token).toBe(ownership.fencing_token);
      const audit = rows("SELECT * FROM audit_event WHERE kind='receipt_recorded' AND subject_id=?", String(r.receipt_id)); expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ exchange_id: r.exchange_id, digest: input.payloadDigest, length: input.payloadLength, outcome: "delivery_ack", created_at: r.created_at });
      expect(Number(audit[0]!.sequence)).toBeGreaterThan(Number(input.messageCreatedAuditSequence));
      // Reception is not application completion or a Message lifecycle transition.
      expect(rows("SELECT state FROM message WHERE message_id=?", input.messageId)[0]!.state).toBe("CREATED");
      expect(rows("SELECT * FROM result WHERE message_id=?", input.messageId)).toEqual([]);
    };
    const denied = async (operation: () => Promise<Reply>) => { const before = snapshot(); expect((await operation()).result.isError).toBe(true); expect(snapshot()).toEqual(before); };
    const idA = await sendChat("pi/A", "to-a"), idB = await sendChat("pi/B", "to-b");
    const metaA = messageEvidence(idA, "chatgpt/main", "pi/A", "ChatGPT → pi/A 🌱"), metaB = messageEvidence(idB, "chatgpt/main", "pi/B", "ChatGPT → pi/B 🌱");
    expect(rows("SELECT * FROM delivery_ack_receipt")).toEqual([]);
    for (const [p, own, other, ownMeta, otherMeta, owner] of [[a, idA, idB, metaA, metaB, ma], [b, idB, idA, metaB, metaA, mb]] as const) {
      const inbox = await p.tool("ce_inbox_list"); expect(inbox.result.isError).not.toBe(true); expect(JSON.stringify(inbox.result)).toContain(own); expect(JSON.stringify(inbox.result)).not.toContain(other);
      expect((await p.tool("ce_read", { messageId: own })).result.isError).not.toBe(true);
      const payload = await p.tool("ce_read_payload", { messageId: own }); expect(payload.result.isError).not.toBe(true);
      expect(payload.result.content[1].text).toBe(`ChatGPT → ${owner.endpointId} 🌱`);
      await denied(() => p.tool("ce_read", { messageId: other })); await denied(() => p.tool("ce_read_payload", { messageId: other }));
      await denied(() => p.tool("ce_ack", otherMeta)); // copied correct digest/length/audit cannot confer recipient authority
      expect((await p.tool("ce_ack", ownMeta)).result.isError).not.toBe(true); ackEvidence(ownMeta, owner);
      const replay = snapshot(); expect((await p.tool("ce_ack", ownMeta)).result.isError).not.toBe(true); expect(snapshot()).toEqual(replay);
      await denied(() => p.tool("ce_send", { to: owner === ma ? "pi/B" : "pi/A", text: "forbidden", idempotencyKey: `pi-pi-${own}` }));
      await denied(() => p.tool("ce_send", { text: "no implicit recipient", idempotencyKey: `implicit-${own}` }));
    }
    let replyNumber = 0;
    const reply = async (p: typeof a, owner: any) => {
      const text = `reply ${owner.endpointId} ${++replyNumber} 🌱`;
      const sent = await p.tool("ce_send", { to: "chatgpt/main", text, idempotencyKey: text }); expect(sent.result.isError).not.toBe(true);
      const meta = messageEvidence(sent.result.details.messageId, owner.endpointId, "chatgpt/main", text);
      const read = await mcp("ce_read_payload", { messageId: meta.messageId }); expect(read.isError).not.toBe(true); expect(JSON.stringify(read)).toContain(text);
      expect((await mcp("ce_ack", meta)).isError).not.toBe(true);
      const chatOwner = rows("SELECT p.participant_id, o.session_id FROM participant p JOIN participant_ownership o USING(participant_id) WHERE p.endpoint_id='chatgpt/main'")[0]!;
      ackEvidence(meta, { participantId: chatOwner.participant_id, sessionId: chatOwner.session_id });
      return meta.messageId;
    };
    const replyA = await reply(a, ma); await reply(b, mb);
    await a.request("stop");
    expect(rows("SELECT * FROM participant_ownership WHERE participant_id=?", ma.participantId)).toEqual([]);
    expect(rows("SELECT detached_at FROM participant_session WHERE participant_id=? AND session_id=?", ma.participantId, ma.sessionId)[0]!.detached_at).not.toBeNull();
    expect(bAuthority()).toEqual(stableB); await reply(b, mb);
    await a.request("replace"); await denied(() => a.tool("ce_inbox_list"));
    await a.request("command", { input: "activate" }); const resumed = await mapping(a); expect(resumed.sessionId).not.toBe(ma.sessionId); assertOwner(resumed);
    expect((await a.request("inspect")).result.confirmations).toBe(1); await reply(a, resumed);
    const transferOwner = rows("SELECT * FROM participant_ownership WHERE participant_id=?", resumed.participantId);
    await a.request("stop", { reason: "reload" }); await a.request("replace"); expect(await mapping(a)).toEqual(resumed); assertOwner(resumed);
    expect(rows("SELECT fencing_token FROM participant_ownership WHERE participant_id=?", resumed.participantId)[0]!.fencing_token).toBe(transferOwner[0]!.fencing_token);
    expect(bAuthority()).toEqual(stableB); await reply(b, mb);

    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true } });
    await c.request("start"); expect(await mapping(c)).toBeUndefined(); await denied(() => c.tool("ce_inbox_list"));
    const beforeC = snapshot(); expect((await mcp("ce_send", { to: "pi/C", text: "unloaded", idempotencyKey: "unloaded-c" })).isError).toBe(true); expect(snapshot()).toEqual(beforeC);
    await reply(a, resumed); await reply(b, mb);
    await c.request("replace"); expect(await mapping(c)).toBeUndefined(); await denied(() => c.tool("ce_inbox_list"));
    await c.request("command", { input: "activate" }); const mc = await mapping(c); expect(mc).toMatchObject({ endpointId: "pi/C" }); assertOwner(mc);
    expect((await c.request("inspect")).result.confirmations).toBe(1); await reply(c, mc);

    // Exercise genuine heartbeat callbacks at IPC checkpoints; no elapsed-time polling or unrelated B writes during denial snapshots.
    const ownerBeforeHeartbeat = bAuthority(); expect((await b.request("heartbeat")).result.callbacks).toBe(1);
    expect(bAuthority().owner[0]!.private_revision).toBeGreaterThan(Number(ownerBeforeHeartbeat.owner[0]!.private_revision));
    const bBeforeRevoke = bAuthority();
    await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
    for (const [name, input] of Object.entries({ ce_inbox_list: {}, ce_read: { messageId: idA }, ce_read_payload: { messageId: idA }, ce_ack: metaA, ce_send: { to: "chatgpt/main", text: "revoked", idempotencyKey: "revoked-a" } })) await denied(() => a.tool(name, input));
    for (const [name, input] of [["ce-status", ""], ["ce-tunnel", "sessions"]]) {
      const before = snapshot(); const result = await a.request("command", { name, input }); expect(result.notices.join("\n")).toMatch(/refus|unavailable|failed|absent/i); expect(result.notices.join("\n")).not.toContain("selected configured active Endpoint IDs"); expect(snapshot()).toEqual(before);
    }
    const beforeRenew = snapshot(); expect((await a.request("heartbeat")).result).toEqual({ callbacks: 1, remaining: 0 }); expect(snapshot()).toEqual(beforeRenew);
    expect(bAuthority()).toEqual(bBeforeRevoke); expect(await mapping(b)).toEqual(mb); await reply(b, mb);
    expect(JSON.stringify(await mcp("ce_inbox_list"))).toContain(replyA); // consciously shared ChatGPT history
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true } });
    for (const [name, input] of Object.entries({ ce_inbox_list: {}, ce_read: { messageId: idA }, ce_read_payload: { messageId: idA }, ce_ack: metaA, ce_send: { to: "chatgpt/main", text: "old epoch", idempotencyKey: "old-epoch-a" } })) await denied(() => a.tool(name, input));
    expect((await a.request("heartbeat")).result.callbacks).toBe(0); await reply(b, mb);
    await a.request("stop"); expect(bAuthority()).toEqual(bBeforeRevoke);
  } finally {
    try {
      const cleanup = await Promise.allSettled(peers.map(p => p.close()));
      try { await client?.close(); } finally { await transport?.close(); }
      for (const result of cleanup) if (result.status === "rejected") throw result.reason;
    } finally { f.cleanup(); }
  }
});
