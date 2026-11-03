/**
 * HANDOFF-CE-SESSION-ONBOARDING-01 — real long-lived MCP child over a live
 * policy descriptor.
 *
 * This is a LOCAL MCP peer, not the ChatGPT cloud: the child process is the
 * real `dist/bin/mcp-stdio.js` bound to `chatgpt/main` with a live policy
 * reference, and the Pi-side endpoints are real CE hosts in this process with
 * their own Store connections. Every ID below is synthetic.
 *
 * Remote/ChatGPT-cloud behavior, the real Pi TUI and any cross-machine
 * reachability remain UNVERIFIED here.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { queryLiveAdoptionProbe } from "../../src/tunnel/live-adoption-probe.js";
import { createExchange } from "../../src/storage/creation.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { initializeStore, openStore, type DurableStore } from "../../src/storage/store.js";
import { readCurrentOwnership } from "../../src/storage/ownership.js";
import { readParticipantByEndpoint } from "../../src/storage/participant.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { createLivePolicyRegistration, initializeLivePolicy, readLivePolicy } from "../../src/tunnel/live-session-policy.js";

const NODE24 = "/Users/zieglar/.local/share/mise/installs/node/24.21.0/bin/node";
const EVIDENCE = "/private/tmp/ce-live-stdio-evidence.json";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

interface Fixture {
  readonly dir: string;
  readonly profilePath: string;
  readonly bindingPath: string;
  readonly store: DurableStore;
  readonly ref: ReturnType<typeof initializeLivePolicy>;
  readonly api: ReturnType<typeof createLivePolicyRegistration>;
  readonly storeOptions: { directory: string; filename: string; busyTimeoutMs: number };
}

function fixture(renewIntervalSeconds = 30): Fixture {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-live-stdio-")));
  dirs.push(dir);
  const bindings = join(dir, ".ce-bindings");
  fs.mkdirSync(bindings, { mode: 0o700 });
  const storeDirectory = join(dir, "store");
  fs.mkdirSync(storeDirectory, { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml");
  const storeOptions = { directory: storeDirectory, filename: "ce-store.sqlite", busyTimeoutMs: 5_000 };
  const store = initializeStore(storeOptions);
  const exchange = { namespace: "ce-live-stdio", idempotencyKey: "idem-live-stdio" };
  const chatgptEndpoint = { adapter: "chatgpt" as const, endpointId: "chatgpt/main" };
  const manifest = {
    kind: "ce-multi-session-v1" as const, version: 1 as const,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
    store: { directory: storeDirectory, file: "ce-store.sqlite" },
    exchange, chatgptEndpoint, mcp: { payloadRead: true, ack: true },
    registrations: [{ endpointId: "pi/A", runtimeSessionId: "sess-A", epoch: 1, status: "active" as const, payloadRead: true, ack: true }],
  };
  const root = join(bindings, "live-policy-synthetic");
  fs.mkdirSync(root, { mode: 0o700 });
  const ref = initializeLivePolicy({ root, manifest });
  const config = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange,
    endpoint: chatgptEndpoint, recipients: [{ adapter: "pi", endpointId: "pi/A" }],
    lease: { ttlSeconds: 120, renewIntervalSeconds }, payloadRead: { enabled: true }, ack: { enabled: true },
    debugExecutionGuard: { enabled: false }, admissionPolicy: ref });
  const pair = publishMessagingGeneration(profilePath, config, { kind: "ce-live-launch-v1", version: 1, ref });
  const api = createLivePolicyRegistration({ ref });
  return { dir, profilePath, bindingPath: pair.bindingPath, store, ref, api, storeOptions };
}

function piHost(store: DurableStore, endpointId: string): CeEndpointHost {
  return new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId }],
    recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }],
    exchangeNamespace: "ce-live-stdio", exchangeIdempotencyKey: "idem-live-stdio",
    leaseTtlSeconds: 300, payloadRead: { enabled: true }, ack: { enabled: true } });
}

function countRows(store: DurableStore, table: "message" | "audit_event"): number {
  const sql = table === "message" ? "SELECT COUNT(*) AS count FROM message" : "SELECT COUNT(*) AS count FROM audit_event";
  const row = store.database.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? -1;
}

function readMetadata(result: unknown): { payloadDigest: string; payloadLength: number; auditSequence: number } {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return JSON.parse(text.match(/of (\{.*\})\. It/)![1]!) as { payloadDigest: string; payloadLength: number; auditSequence: number };
}

it("real live MCP child keeps one chatgpt Owner, serves A and B exactly, and refuses revoked B", { timeout: 60_000 }, async () => {
  const f = fixture();
  const hostA = piHost(f.store, "pi/A");
  hostA.beginSession("pi/A");
  const childEnv: Record<string, string> = { PATH: "/Users/zieglar/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin" };
  if (process.env["HOME"] !== undefined) childEnv["HOME"] = process.env["HOME"];
  const transport = new StdioClientTransport({ command: NODE24, args: [join(process.cwd(), "dist/bin/mcp-stdio.js"), "--config", f.bindingPath], env: childEnv, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", (b) => { diagnostics += String(b); });
  const client = new Client({ name: "live-stdio-fixture", version: "1" });
  let childPid: number | null = null;
  const evidence: Record<string, unknown> = { transport: "local-mcp-stdio-peer", cloud: "UNVERIFIED" };
  const send = (to: string, key: string, text: string) => client.callTool({ name: "ce_send", arguments: { to, text, idempotencyKey: key } });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack", "ce_endpoints"]);
    expect((await client.callTool({ name: "ping", arguments: {} })).isError).not.toBe(true);

    childPid = transport.pid;
    expect(childPid).not.toBeNull();
    const chatgptParticipant = readParticipantByEndpoint(f.store, "chatgpt", "chatgpt/main")!;
    const ownershipBefore = readCurrentOwnership(f.store, chatgptParticipant.participantId)!;
    evidence["childPid"] = childPid;

    // chatgpt -> pi/A, exact payload and ACK on the Pi side.
    const toA = await send("pi/A", "k-a-1", "synthetic-live-a");
    expect(toA.isError).not.toBe(true);
    const aMessageId = (toA.structuredContent as { messageId: string }).messageId;
    const aPayload = hostA.readPayload("pi/A", { messageId: aMessageId });
    expect(aPayload.payloadText).toBe("synthetic-live-a");
    const aAck = hostA.acknowledge("pi/A", { messageId: aMessageId, payloadDigest: aPayload.payloadDigest, payloadLength: aPayload.payloadLength, messageCreatedAuditSequence: aPayload.auditSequence });
    expect(aAck.receipt.receiptId).toBeTruthy();

    // pi/A -> chatgpt, exact payload and ACK on the child side.
    const fromA = hostA.send("pi/A", { to: "chatgpt/main", text: "synthetic-live-a-reply", idempotencyKey: "k-a-2" });
    const readReply = await client.callTool({ name: "ce_read_payload", arguments: { messageId: fromA.messageId } });
    expect(readReply.isError).not.toBe(true);
    expect((readReply.content as { text: string }[])[1]!.text).toBe("synthetic-live-a-reply");
    const replyMeta = readMetadata(readReply);
    const replyAck = await client.callTool({ name: "ce_ack", arguments: { messageId: fromA.messageId, payloadDigest: replyMeta.payloadDigest, payloadLength: replyMeta.payloadLength, messageCreatedAuditSequence: replyMeta.auditSequence } });
    expect(replyAck.isError).not.toBe(true);

    // Publish B into the live chain: same child PID, same Owner Session/fence.
    const tip = readLivePolicy(f.ref);
    const published = f.api.register({ expectedDigest: tip.digest, registration: { endpointId: "pi/B", runtimeSessionId: "sess-B", payloadRead: true, ack: true, presenceDisclosure: false } });
    expect(published.snapshot.sequence).toBe(tip.sequence + 1);
    expect(transport.pid).toBe(childPid);
    const ownershipAfter = readCurrentOwnership(f.store, chatgptParticipant.participantId)!;
    expect(ownershipAfter.sessionId).toBe(ownershipBefore.sessionId);
    expect(ownershipAfter.fencingToken).toBe(ownershipBefore.fencingToken);
    evidence["ownerStable"] = { sessionIdUnchanged: true, fencingTokenUnchanged: true, childPidUnchanged: true };

    // Before B joins the Exchange: refused, with zero durable Message/Audit writes.
    const messagesBefore = countRows(f.store, "message");
    const auditBefore = countRows(f.store, "audit_event");
    const preJoin = await send("pi/B", "k-b-prejoin", "synthetic-prejoin");
    expect(preJoin.isError).toBe(true);
    expect(countRows(f.store, "message")).toBe(messagesBefore);
    expect(countRows(f.store, "audit_event")).toBe(auditBefore);
    evidence["preJoin"] = { refused: true, messageWrites: 0, auditWrites: 0 };

    // B joins with its own Store connection and its own Host.
    const storeB = openStore(f.storeOptions);
    const hostB = piHost(storeB, "pi/B");
    hostB.beginSession("pi/B");
    try {
      const toB = await send("pi/B", "k-b-1", "synthetic-live-b");
      expect(toB.isError).not.toBe(true);
      const bMessageId = (toB.structuredContent as { messageId: string }).messageId;
      const bPayload = hostB.readPayload("pi/B", { messageId: bMessageId });
      expect(bPayload.payloadText).toBe("synthetic-live-b");
      const bAck = hostB.acknowledge("pi/B", { messageId: bMessageId, payloadDigest: bPayload.payloadDigest, payloadLength: bPayload.payloadLength, messageCreatedAuditSequence: bPayload.auditSequence });
      expect(bAck.receipt.receiptId).toBeTruthy();

      // pi/B -> chatgpt over the same child.
      const fromB = hostB.send("pi/B", { to: "chatgpt/main", text: "synthetic-live-b-reply", idempotencyKey: "k-b-2" });
      const readB = await client.callTool({ name: "ce_read_payload", arguments: { messageId: fromB.messageId } });
      expect(readB.isError).not.toBe(true);
      expect((readB.content as { text: string }[])[1]!.text).toBe("synthetic-live-b-reply");
      const bMeta = readMetadata(readB);
      const replyBAck = await client.callTool({ name: "ce_ack", arguments: { messageId: fromB.messageId, payloadDigest: bMeta.payloadDigest, payloadLength: bMeta.payloadLength, messageCreatedAuditSequence: bMeta.auditSequence } });
      expect(replyBAck.isError).not.toBe(true);
      expect(replyBAck.structuredContent).toMatchObject({ receipt: { messageId: fromB.messageId, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, kind: "delivery_ack" } });
      expect(replyAck.structuredContent).toMatchObject({ receipt: { messageId: fromA.messageId, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, kind: "delivery_ack" } });

      // Cross-Endpoint reads and ACKs refuse.
      expect(() => hostA.readPayload("pi/A", { messageId: bMessageId })).toThrow();
      expect(() => hostA.acknowledge("pi/A", { messageId: bMessageId, payloadDigest: bPayload.payloadDigest, payloadLength: bPayload.payloadLength, messageCreatedAuditSequence: bPayload.auditSequence })).toThrow();
      expect(() => hostB.readPayload("pi/B", { messageId: aMessageId })).toThrow();
      expect(() => hostB.acknowledge("pi/B", { messageId: aMessageId, payloadDigest: aPayload.payloadDigest, payloadLength: aPayload.payloadLength, messageCreatedAuditSequence: aPayload.auditSequence })).toThrow();
      evidence["crossEndpoint"] = { aCannotReadB: true, aCannotAckB: true, bCannotReadA: true, bCannotAckA: true };

      // Discovery is closed and reveals no internal identity.
      const discovery = await client.callTool({ name: "ce_endpoints", arguments: {} });
      expect(discovery.isError).not.toBe(true);
      const projection = discovery.structuredContent as Record<string, unknown>;
      expect(projection["targets"]).toEqual(expect.arrayContaining([expect.objectContaining({ adapter: "pi", endpointId: "pi/B" })]));
      const serialized = JSON.stringify(projection);
      for (const forbidden of ["sessionId", "participantId", "fencingToken", "policyId", "genesisDigest", "sequence", "runtimeSessionId", "ce-live-session-v1"]) {
        expect(serialized).not.toContain(forbidden);
      }
      await expect(client.callTool({ name: "ce_endpoints", arguments: { endpointId: "pi/A" } })).rejects.toMatchObject({ code: -32602 });
      evidence["discovery"] = { targets: (projection["targets"] as { endpointId: string }[]).map((t) => t.endpointId).sort(), leaksInternalIds: false };

      // Revoke B: absent from discovery and denied on send, while A continues.
      const current = readLivePolicy(f.ref);
      f.api.revoke({ expectedDigest: current.digest, endpointId: "pi/B" });
      const afterRevoke = await client.callTool({ name: "ce_endpoints", arguments: {} });
      const revokedProjection = afterRevoke.structuredContent as { targets: { endpointId: string }[] };
      expect(revokedProjection.targets.map((t) => t.endpointId)).not.toContain("pi/B");
      expect((await send("pi/B", "k-b-revoked", "synthetic-revoked")).isError).toBe(true);
      expect((await send("pi/A", "k-a-after-revoke", "synthetic-a-after-revoke")).isError).not.toBe(true);
      evidence["revocation"] = { bAbsentFromTargets: true, bSendDenied: true, aStillServed: true };

      evidence["messages"] = { aMessageId, bMessageId, fromA: fromA.messageId, fromB: fromB.messageId,
        aPayloadDigest: aPayload.payloadDigest, aPayloadLength: aPayload.payloadLength, aAuditSequence: aPayload.auditSequence,
        bPayloadDigest: bPayload.payloadDigest, bPayloadLength: bPayload.payloadLength, bAuditSequence: bPayload.auditSequence };
      evidence["receipts"] = { aAck, bAck, replyAck: replyAck.structuredContent, replyBAck: replyBAck.structuredContent };
      evidence["payloads"] = [
        { messageId: aMessageId, digest: aPayload.payloadDigest, bytes: Buffer.from(aPayload.payloadText).toString("hex"), length: aPayload.payloadLength, auditSequence: aPayload.auditSequence },
        { messageId: bMessageId, digest: bPayload.payloadDigest, bytes: Buffer.from(bPayload.payloadText).toString("hex"), length: bPayload.payloadLength, auditSequence: bPayload.auditSequence },
        { messageId: fromA.messageId, ...replyMeta, bytes: Buffer.from("synthetic-live-a-reply").toString("hex") },
        { messageId: fromB.messageId, ...bMeta, bytes: Buffer.from("synthetic-live-b-reply").toString("hex") },
      ];
      fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    } finally {
      hostB.end("pi/B");
      storeB.close();
    }
    expect(diagnostics).toContain("CE_MCP_STARTED");
  } finally {
    await client.close();
    await transport.close();
    await vi.waitFor(() => expect(diagnostics).toContain("CE_MCP_STOPPED released=true detached=true"), { timeout: 5_000 });
    if (childPid !== null) await vi.waitFor(() => {
      let absent = false;
      try { process.kill(childPid!, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      expect(absent).toBe(true);
    }, { timeout: 5_000 });
    expect(readCurrentOwnership(f.store, readParticipantByEndpoint(f.store, "chatgpt", "chatgpt/main")!.participantId)).toBeUndefined();
    hostA.end("pi/A");
    f.store.close();
  }
});

it("real child permanently stops renewal after invalid policy; restored successor cannot revive writes", { timeout: 60_000 }, async () => {
  const f = fixture(1);
  const host = piHost(f.store, "pi/A"); host.beginSession("pi/A");
  const env: Record<string, string> = { PATH: "/Users/zieglar/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  const transport = new StdioClientTransport({ command: NODE24, args: [join(process.cwd(), "dist/bin/mcp-stdio.js"), "--config", f.bindingPath], env, stderr: "pipe" });
  const client = new Client({ name: "terminal-live-stdio", version: "1" });
  let diagnostics = "";
  let stopped!: () => void;
  const renewalStopped = new Promise<void>(resolve => { stopped = resolve; });
  transport.stderr?.on("data", b => { diagnostics += String(b); if (diagnostics.includes("CE_MCP_RENEWAL_STOPPED code=CE_HOST_AUTHORITY_ABSENT")) stopped(); });
  const genesisPath = join(f.ref.root, "000000.json");
  const genesis = fs.readFileSync(genesisPath);
  try {
    await client.connect(transport);
    const pid = transport.pid!; expect(pid).toBeGreaterThan(0);
    const startedKey = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).trim();
    const identity = { pid, startedKey };
    const launchDigest = createHash("sha256").update(fs.readFileSync(f.bindingPath)).digest("hex");
    const exchangeId = createExchange(f.store, { namespace: "ce-live-stdio", idempotencyKey: "idem-live-stdio" }).exchange.exchangeId;
    const owner = () => {
      const participant = readParticipantByEndpoint(f.store, "chatgpt", "chatgpt/main")!;
      const term = readCurrentOwnership(f.store, participant.participantId)!;
      return { endpointId: "chatgpt/main", registered: true, participantId: participant.participantId, sessionId: term.sessionId,
        exchangeId, fencingToken: term.fencingToken, lease: "ACTIVE", leaseExpiresAt: term.expiresAt };
    };
    const query = () => queryLiveAdoptionProbe({ ref: f.ref, identity, launchDigest, current: readLivePolicy(f.ref), targetEndpointId: "pi/A", owner: owner() });
    expect(await query()).toEqual({ kind: "OBSERVED" });
    const initialOwner = owner();
    fs.writeFileSync(genesisPath, "invalid-policy");
    // Wait for the actual renewal event, bounded by a deadline; no guessed sleep.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([renewalStopped, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("no renewal_stopped event")), 10_000); })]); }
    finally { clearTimeout(timer); fs.writeFileSync(genesisPath, genesis); }
    expect(diagnostics).toContain("CE_MCP_RENEWAL_STOPPED code=CE_HOST_AUTHORITY_ABSENT");
    const tip = readLivePolicy(f.ref);
    f.api.register({ expectedDigest: tip.digest, registration: { endpointId: "pi/B", runtimeSessionId: "terminal-B", payloadRead: true, ack: true, presenceDisclosure: true } });
    // Give A explicit presence consent so discovery can expose PORT_BLOCKED.
    f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "sess-A", payloadRead: true, ack: true, presenceDisclosure: true } });
    expect(await query()).toEqual({ kind: "BLOCKED" });
    const before = { messages: countRows(f.store, "message"), audit: countRows(f.store, "audit_event") };
    for (const to of ["pi/A", "pi/B"]) {
      expect((await client.callTool({ name: "ce_send", arguments: { to, text: "terminal-must-not-persist", idempotencyKey: `terminal-${to}` } })).isError).toBe(true);
    }
    const discovery = await client.callTool({ name: "ce_endpoints", arguments: {} });
    expect(discovery.isError).not.toBe(true);
    expect(discovery.structuredContent).toMatchObject({ self: { ownCapabilities: { send: false, ack: false } }, targets: expect.arrayContaining([expect.objectContaining({ endpointId: "pi/A", reason: "MCP_OPERATION_BLOCKED", reachable: "false" })]) });
    expect(countRows(f.store, "message")).toBe(before.messages); expect(countRows(f.store, "audit_event")).toBe(before.audit);
    expect(transport.pid).toBe(pid);
    expect(owner().sessionId).toBe(initialOwner.sessionId); expect(owner().fencingToken).toBe(initialOwner.fencingToken);
    const expiry = owner().leaseExpiresAt;
    // Observe beyond another renewal interval with bounded polling; a restarted
    // heartbeat would extend the persisted lease, even if it emitted no log.
    const until = Date.now() + 1400;
    await vi.waitFor(async () => { expect(await query()).toEqual({ kind: "BLOCKED" }); expect(owner().leaseExpiresAt).toBe(expiry); expect(Date.now()).toBeGreaterThanOrEqual(until); }, { timeout: 4000, interval: 200 });
    const evidence = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
    evidence.terminal = { probeBefore: "OBSERVED", probeAfter: "BLOCKED", renewalStopped: true, noLeaseExtension: true, ownerUnchanged: true, writeRefused: true, discoveryReason: "MCP_OPERATION_BLOCKED", cloud: "UNVERIFIED" };
    fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  } finally {
    fs.writeFileSync(genesisPath, genesis);
    await client.close(); await transport.close();
    try {
      await vi.waitFor(() => expect(diagnostics).toContain("CE_MCP_STOPPED released=true detached=true"), { timeout: 5000 });
      expect(transport.pid).toBeNull();
    } finally { host.end("pi/A"); f.store.close(); }
  }
});
