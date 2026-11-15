/** Isolated real Pi RPC + CE MCP stdio correlation test. Uses a scripted local
 * provider; it never calls a network model or a production Store. */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { initializeStore } from "../../dist/storage/store.js";
import { createExchange } from "../../dist/storage/creation.js";
import { initializeLivePolicy, createLivePolicyRegistration } from "../../dist/tunnel/live-session-policy.js";
import { parseMcpBindingConfig } from "../../dist/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../dist/tunnel/profile.js";

assert(process.env.CE_CORRELATION_TEST_HOME && process.env.HOME === process.env.CE_CORRELATION_TEST_HOME, "explicit disposable HOME required");
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-real-correlation-")));
const agent = join(root, "agent"), sessions = join(root, "sessions"), workspace = join(root, "workspace");
for (const p of [agent, sessions, workspace]) fs.mkdirSync(p, { mode: 0o700 });
const session = SessionManager.create(workspace, sessions);
session.appendMessage({ role: "user", content: "Isolated correlation fixture", timestamp: Date.now() });
const endpoint = `pi/dogfood-${randomUUID()}`;
const store = initializeStore({ directory: join(root, "store"), filename: "ce.sqlite" });
const exchangeId = createExchange(store, { namespace: "correlation-dogfood", idempotencyKey: "test" }).exchange.exchangeId;
const inboundPolicy = join(root, "native-inbound.json");
fs.writeFileSync(inboundPolicy, JSON.stringify({ version: 1, enabled: true, runtimeSessionId: session.getSessionId(), endpointId: endpoint, exchangeId, from: "chatgpt/fixture", activatedAt: new Date(Date.now() - 1000).toISOString(), afterAuditSequence: 0, maxAgeSeconds: 300 }), { mode: 0o600 });
const policyRoot = join(root, "policy"); fs.mkdirSync(policyRoot, { mode: 0o700 });
const profilePath = join(root, "profile.yaml"), keyFile = join(root, "synthetic-credential");
fs.writeFileSync(keyFile, "synthetic-not-a-live-credential", { mode: 0o600 });
const manifest = { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
  store: { directory: join(root, "store"), file: "ce.sqlite" }, exchange: { namespace: "correlation-dogfood", idempotencyKey: "test" },
  chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/fixture" }, mcp: { payloadRead: true, ack: false },
  registrations: [{ runtimeSessionId: "seed", endpointId: "pi/seed", epoch: 1, status: "revoked", payloadRead: false, ack: false }] };
const ref = initializeLivePolicy({ root: policyRoot, manifest });
const snapshot = (await import("../../dist/tunnel/live-session-policy.js")).readLivePolicy(ref);
createLivePolicyRegistration({ ref }).register({ expectedDigest: snapshot.digest, registration: { runtimeSessionId: session.getSessionId(), endpointId: endpoint, payloadRead: true, ack: false, presenceDisclosure: true } });
const binding = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint,
  recipients: [{ adapter: "pi", endpointId: endpoint }], payloadRead: { enabled: true }, ack: { enabled: false }, admissionPolicy: ref });
fs.mkdirSync(join(root, ".ce-bindings"), { mode: 0o700 });
const pair = publishMessagingGeneration(profilePath, binding, { kind: "ce-live-launch-v1", version: 1, ref }, { credentialFile: keyFile });
fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: manifest.identity.tunnelId, keyFile,
  healthUrlFile: join(root, "unused-health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(pkg, "dist/bin/mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
const control = join(root, "control.json"), guard = join(root, "offline-guard.cjs"), attempts = join(root, "network-attempts");
fs.writeFileSync(guard, `const fs=require('node:fs');const deny=()=>{fs.appendFileSync(${JSON.stringify(attempts)},'attempt\\n');throw Error('NETWORK_FORBIDDEN')};globalThis.fetch=deny;for(const n of ['node:http','node:https']){const m=require(n);m.request=deny;m.get=deny;}require('node:net').Socket.prototype.connect=deny;require('node:module').syncBuiltinESMExports();`, { mode: 0o600 });
const cli = join(pkg, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const ai = pathToFileURL(resolve(dirname(fs.realpathSync(cli)), "../../pi-ai/dist/index.js")).href;
const fake = join(root, "scripted-provider.ts");
fs.writeFileSync(fake, `import fs from 'node:fs'; import {createAssistantMessageEventStream} from ${JSON.stringify(ai)};
let step=0, mode='initial';
export default function(pi) {
  pi.registerProvider('cefixture', {
    baseUrl:'http://127.0.0.1:1', apiKey:'synthetic', api:'cefixture-api',
    models:[{id:'local',name:'Local fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024}],
    streamSimple(model) {
      const stream=createAssistantMessageEventStream();
      queueMicrotask(async () => {
        for (let i=0; i<200 && !fs.existsSync(${JSON.stringify(control)}); i++) await new Promise(resolve => setTimeout(resolve, 10));
        const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
        if (c.mode !== mode) { mode=c.mode; step=0; }
        const output={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
        stream.push({type:'start',partial:output});
        if(step<2) {
          const call=step++===0 ? {type:'toolCall',id:'fixture-read-'+mode,name:'ce_receive_task',arguments:{messageId:c.messageId}} :
            {type:'toolCall',id:'fixture-reply-'+mode,name:'ce_send',arguments:{to:'chatgpt/fixture',text:'isolated Pi result',idempotencyKey:mode==='initial'?'pi-fixture-reply':'pi-fixture-forbidden',replyTo:c.messageId}};
          output.content.push(call); output.stopReason='toolUse';
          stream.push({type:'toolcall_start',contentIndex:0,partial:output});
          stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:output});
        } else output.content.push({type:'text',text:'done'});
        stream.push({type:'done',reason:output.stopReason,message:output}); stream.end();
      });
      return stream;
    }
  });
}` , { mode: 0o600 });
const env = { HOME: process.env.HOME, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "dumb",
  PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  XDG_CONFIG_HOME: join(root,"xdg-config"), XDG_DATA_HOME: join(root,"xdg-data"), XDG_CACHE_HOME: join(root,"xdg-cache"), XDG_STATE_HOME: join(root,"xdg-state"),
  CE_TUNNEL_PROFILE: profilePath, CE_NATIVE_INBOUND_POLICY: inboundPolicy, CE_ALLOWLIST: "", CE_STORE_DIR: "", CE_STORE_FILE: "", NODE_OPTIONS: `--require=${guard}` };
const child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-mcp", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--model", "cefixture/local", "--extension", join(pkg, "pi-extension/index.ts"), "--extension", fake, "--session", session.getSessionFile()], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = ""; child.stderr.on("data", b => { stderr = (stderr + b).slice(-16000); });
const pending = new Map(), events = [], lines = createInterface({ input: child.stdout });
lines.on("line", line => { let r; try { r = JSON.parse(line); } catch { return; } events.push(r); if (r.type !== "response" || !pending.has(r.id)) return; const p = pending.get(r.id); pending.delete(r.id); clearTimeout(p.timer); r.success ? p.resolve(r.data) : p.reject(Error(`RPC_${r.command}_FAILED`)); });
child.on("exit", code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error(`PI_EXIT_${code}`)); } pending.clear(); });
function rpc(type, extra = {}) { return new Promise((resolveCall, reject) => { const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC_${type}_TIMEOUT`)); }, 20000); pending.set(id, { resolve: resolveCall, reject, timer }); child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n"); }); }
async function waitFor(predicate, label) { const deadline = Date.now()+20000; while (Date.now()<deadline) { const item=events.find(predicate); if(item) return item; if(child.exitCode!==null) throw Error(`PI_EXIT_${child.exitCode}`); await new Promise(r=>setTimeout(r,25)); } throw Error(`${label}_TIMEOUT`); }
const transport = new StdioClientTransport({ command: process.execPath, args: [join(pkg, "dist/bin/mcp-stdio.js"), "--config", pair.bindingPath], env, cwd: workspace, stderr: "pipe" });
const client = new Client({ name: "correlation-dogfood", version: "1" });
const result = r => { assert(!r.isError, JSON.stringify(r)); return r.structuredContent ?? JSON.parse(r.content.find(c=>c.type==="text").text); };
try {
  await rpc("get_state"); await client.connect(transport);
  const originalMcpPid = transport.pid; assert.equal(typeof originalMcpPid, "number");
  const request = result(await client.callTool({ name: "ce_send", arguments: { to: endpoint, text: "isolated task", idempotencyKey: "mcp-fixture-request" } }));
  const requestLink = store.database.prepare("SELECT target_runtime_session_id,binding_epoch,target_owner_session_id FROM message_association WHERE message_id=?").get(request.messageId);
  assert.equal(requestLink.target_runtime_session_id, session.getSessionId());
  assert.equal(requestLink.binding_epoch, 1);
  assert.equal(typeof requestLink.target_owner_session_id, "string");
  fs.writeFileSync(control, JSON.stringify({ mode: "initial", messageId: request.messageId }), { mode: 0o600 });
  const readEnd = await waitFor(e => e.type === "tool_execution_end" && e.toolName === "ce_receive_task", "PI_RECEIVE_TASK"); assert(!readEnd.isError);
  const replyEnd = await waitFor(e => e.type === "tool_execution_end" && e.toolName === "ce_send", "PI_REPLY"); assert(!replyEnd.isError);
  const ackBefore = store.database.prepare("SELECT count(*) AS n FROM delivery_ack_receipt").get().n;
  const before = result(await client.callTool({ name: "ce_find_replies", arguments: { requestMessageId: request.messageId } }));
  assert.equal(before.replies.length, 1);
  const body = await client.callTool({ name: "ce_read_payload", arguments: { messageId: before.replies[0].messageId } });
  assert(!body.isError && body.content.some(part => part.type === "text" && part.text === "isolated Pi result"));
  const association = JSON.stringify(store.database.prepare("SELECT * FROM message_association WHERE request_message_id=? ORDER BY message_id").all(request.messageId));
  await waitFor(e => e.type === "agent_settled", "PI_SETTLED");
  const switched = await rpc("new_session"); assert.equal(switched.cancelled, false);
  fs.writeFileSync(control, JSON.stringify({ mode: "wrong-session", messageId: request.messageId }), { mode: 0o600 });
  const eventOffset = events.length;
  const secondPrompt = await rpc("prompt", { message: "Attempt the old fixture task in this new session." });
  assert.equal(secondPrompt.disposition, "started");
  const wrongRead = await waitFor(e => events.indexOf(e) >= eventOffset && e.type === "tool_execution_end" && e.toolName === "ce_receive_task", "WRONG_SESSION_READ");
  assert.equal(wrongRead.isError, true);
  const wrongReply = await waitFor(e => events.indexOf(e) >= eventOffset && e.type === "tool_execution_end" && e.toolName === "ce_send", "WRONG_SESSION_REPLY");
  assert.equal(wrongReply.isError, true);
  await waitFor(e => events.indexOf(e) >= eventOffset && e.type === "agent_settled", "WRONG_SESSION_SETTLED");
  const after = result(await client.callTool({ name: "ce_find_replies", arguments: { requestMessageId: request.messageId } }));
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM delivery_ack_receipt").get().n, ackBefore);
  assert.deepEqual(after.replies, before.replies);
  const ownerBefore = store.database.prepare("SELECT o.session_id FROM participant_ownership o JOIN participant p ON p.participant_id=o.participant_id WHERE p.endpoint_adapter='chatgpt' AND p.endpoint_id='chatgpt/fixture'").get()?.session_id;
  assert.equal(typeof ownerBefore, "string");
  await client.close();
  const transport2 = new StdioClientTransport({ command: process.execPath, args: [join(pkg, "dist/bin/mcp-stdio.js"), "--config", pair.bindingPath], env, cwd: workspace, stderr: "pipe" });
  const client2 = new Client({ name: "correlation-dogfood-rebound", version: "1" });
  try {
    await client2.connect(transport2);
    const ownerAfter = store.database.prepare("SELECT o.session_id FROM participant_ownership o JOIN participant p ON p.participant_id=o.participant_id WHERE p.endpoint_adapter='chatgpt' AND p.endpoint_id='chatgpt/fixture'").get()?.session_id;
    assert.equal(typeof ownerAfter, "string"); assert.notEqual(ownerAfter, ownerBefore);
    const rebound = result(await client2.callTool({ name: "ce_find_replies", arguments: { requestMessageId: request.messageId } }));
    assert.deepEqual(rebound.replies, before.replies);
  } finally { await client2.close(); }
  assert.equal(JSON.stringify(store.database.prepare("SELECT * FROM message_association WHERE request_message_id=? ORDER BY message_id").all(request.messageId)), association);
  assert.equal(fs.existsSync(attempts), false);
  console.log(JSON.stringify({ status: "PASS", realPiPid: child.pid, realMcpPid: originalMcpPid, requestMessageId: request.messageId, replyMessageId: before.replies[0].messageId, sessionSwitchPreservedAssociation: true, wrongSessionReadAndReplyRejected: true, senderOwnerReboundQueryPassed: true, networkAttempts: 0, syntheticModel: true, automaticInboundClaimTested: true }));
} finally {
  await client.close().catch(()=>{}); const exited = child.exitCode !== null ? Promise.resolve() : new Promise(r=>child.once("exit",r)); child.stdin.end(); const timer=setTimeout(()=>child.kill("SIGTERM"),5000); await exited; clearTimeout(timer); lines.close(); store.close();
  if (stderr) fs.writeFileSync(join(root,"pi-stderr.log"),stderr,{mode:0o600});
}
