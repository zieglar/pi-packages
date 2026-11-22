/** Opt-in real Pi RPC /new + real CE MCP stdio dogfood. No Tunnel/model calls.
 * Run only with HOME=CE_SESSION_SWITCH_TEST_HOME pointing to a disposable HOME
 * containing a verified public Native cache. Every other artifact is temporary. */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { initializeStore } from "../../dist/storage/store.js";
import { initializeLivePolicy, prepareLivePolicyUpgrade, readLivePolicy, createLivePolicyRegistration } from "../../dist/tunnel/live-session-policy.js";
import { parseMcpBindingConfig } from "../../dist/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../dist/tunnel/profile.js";

assert(process.env.CE_SESSION_SWITCH_TEST_HOME && process.env.HOME === process.env.CE_SESSION_SWITCH_TEST_HOME, "explicit disposable HOME required");
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-real-session-switch-")));
const agent = join(root, "agent"), sessions = join(root, "sessions"), workspace = join(root, "workspace");
for (const p of [agent, sessions, workspace]) fs.mkdirSync(p, { mode: 0o700 });
const old = SessionManager.create(workspace, sessions);
old.appendMessage({ role: "user", content: "Isolated lifecycle fixture; no model request", timestamp: Date.now() });
const previousEndpointId = `pi/dogfood-${randomUUID()}`;
const store = initializeStore({ directory: join(root, "store"), filename: "ce.sqlite" });
const policyRoot = join(root, "policy"); fs.mkdirSync(policyRoot, { mode: 0o700 });
const profilePath = join(root, "profile.yaml"), keyFile = join(root, "synthetic-credential");
fs.writeFileSync(keyFile, "synthetic-not-a-live-credential", { mode: 0o600 });
const manifest = { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
  store: { directory: join(root, "store"), file: "ce.sqlite" }, exchange: { namespace: "session-switch-dogfood", idempotencyKey: "test" },
  chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/fixture" }, mcp: { payloadRead: true, ack: true },
  registrations: [{ runtimeSessionId: "seed", endpointId: "pi/seed", epoch: 1, status: "revoked", payloadRead: false, ack: false }] };
const v1 = initializeLivePolicy({ root: policyRoot, manifest });
createLivePolicyRegistration({ ref: v1 }).register({ expectedDigest: readLivePolicy(v1).digest,
  registration: { runtimeSessionId: old.getSessionId(), endpointId: previousEndpointId, payloadRead: false, ack: false, presenceDisclosure: true } });
const ref = prepareLivePolicyUpgrade(v1, profilePath);
const policy = createLivePolicyRegistration({ ref });
const register = (runtimeSessionId, endpointId) => policy.register({ expectedDigest: readLivePolicy(ref).digest,
  registration: { runtimeSessionId, endpointId, payloadRead: false, ack: false, presenceDisclosure: true } });
const binding = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint,
  recipients: [{ adapter: "pi", endpointId: previousEndpointId }], payloadRead: { enabled: true }, ack: { enabled: true }, admissionPolicy: ref });
fs.mkdirSync(join(root, ".ce-bindings"), { mode: 0o700 });
const pair = publishMessagingGeneration(profilePath, binding, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: keyFile });
fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: manifest.identity.tunnelId, keyFile,
  healthUrlFile: join(root, "unused-health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(pkg, "dist/bin/mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
policy.upgrade({ expectedDigest: readLivePolicy(v1).digest, actorRuntimeSessionId: old.getSessionId(),
  profileRevision: createHash("sha256").update(fs.readFileSync(profilePath)).digest("hex"),
  bindingGeneration: /messaging-([a-f0-9]{64})\.yaml$/.exec(pair.bindingPath)[1] });
const lifecycle = join(root, "lifecycle.jsonl"), trace = join(root, "trace.ts"), attempts = join(root, "network-attempts.jsonl"), guard = join(root, "offline-guard.cjs");
const cancelMarker = join(root, "cancel-next-new");
fs.writeFileSync(trace, `import fs from 'node:fs'; import {randomUUID} from 'node:crypto'; export default function(pi) {
 const instance=randomUUID();
 pi.on('session_before_switch',event=>event.reason==='new' && fs.existsSync(${JSON.stringify(cancelMarker)}) ? {cancel:true} : undefined);
 for (const type of ['session_start','session_shutdown']) pi.on(type,(event,ctx)=>{
  const record={type,reason:event.reason,instance,nativeSessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),previousSessionFile:event.previousSessionFile,targetSessionFile:event.targetSessionFile};
  fs.appendFileSync(${JSON.stringify(lifecycle)},JSON.stringify(record)+'\\n',{mode:0o600});
  if(type==='session_start') pi.appendEntry('ce-dogfood-runtime',{instance});
 });
}`, { mode: 0o600 });
fs.writeFileSync(guard, `const fs=require('node:fs'); const deny=()=>{fs.appendFileSync(${JSON.stringify(attempts)},'network-attempt\\n');throw Error('DOGFOOD_NETWORK_FORBIDDEN')};
globalThis.fetch=deny; for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}require('node:net').Socket.prototype.connect=deny;require('node:module').syncBuiltinESMExports();`, { mode: 0o600 });
fs.writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { cesynthetic: { name: "Offline fixture", api: "openai-completions", apiKey: "synthetic", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "stub-local", name: "stub-local", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }), { mode: 0o600 });
const env = { HOME: process.env.HOME, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "dumb" };
Object.assign(env, { HOME: process.env.HOME, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  XDG_CONFIG_HOME: join(root,"xdg-config"), XDG_DATA_HOME: join(root,"xdg-data"), XDG_CACHE_HOME: join(root,"xdg-cache"), XDG_STATE_HOME: join(root,"xdg-state"),
  CE_TUNNEL_PROFILE: profilePath, CE_ALLOWLIST: "", CE_STORE_DIR: "", CE_STORE_FILE: "", NODE_OPTIONS: `--require=${guard}` });
const cli = join(pkg, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-mcp", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
  "--model", "cesynthetic/stub-local", "--extension", join(pkg, "pi-extension/index.ts"), "--extension", trace, "--session", old.getSessionFile()], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "", stderrMcp = "";
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-65536); });
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  let record; try { record = JSON.parse(line); } catch { return; }
  if (record.type !== "response" || !pending.has(record.id)) return;
  const call = pending.get(record.id); pending.delete(record.id); clearTimeout(call.timer);
  if (record.success) call.resolve(record.data); else call.reject(new Error(`RPC_${record.command}_FAILED`));
});
child.on("exit", code => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(`RPC_EXIT_${code}`)); } pending.clear(); });
function rpc(type) {
  return new Promise((resolveCall, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC_${type}_TIMEOUT`)); }, 20000);
    pending.set(id, { resolve: resolveCall, reject, timer }); child.stdin.write(JSON.stringify({ id, type }) + "\n");
  });
}
const transport = new StdioClientTransport({ command: process.execPath, args: [join(pkg, "dist/bin/mcp-stdio.js"), "--config", pair.bindingPath], env, cwd: workspace, stderr: "pipe" });
const client = new Client({ name: "session-switch-dogfood", version: "1" });
const parseResult = result => {
  assert(!result.isError, "MCP operation refused");
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === "text").text);
};
let evidence;
try {
  await rpc("get_state");
  const oldEntries = fs.readFileSync(old.getSessionFile(), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert(oldEntries.some(e => e.customType === "ce-mapping"), "old Pi was not independently bound");
  await client.connect(transport);
  transport.stderr?.on("data", chunk => { stderrMcp = (stderrMcp + chunk).slice(-65536); });
  const sent = parseResult(await client.callTool({ name: "ce_send", arguments: { to: previousEndpointId, text: "Pending fixture work: must never be replayed by /new", idempotencyKey: "pending-before-new" } }));
  const messageBefore = JSON.stringify(store.database.prepare("SELECT * FROM message ORDER BY message_id").all());
  const receiptsBefore = JSON.stringify(store.database.prepare("SELECT * FROM delivery_ack_receipt").all());
  fs.writeFileSync(cancelMarker, "cancel", { mode: 0o600 });
  assert.equal((await rpc("new_session")).cancelled, true);
  assert.equal(parseResult(await client.callTool({ name: "ce_endpoints", arguments: { previousEndpointId } })).sessionSwitch.status, "unknown");
  assert(!fs.readFileSync(lifecycle,"utf8").trim().split("\n").map(line=>JSON.parse(line)).some(event=>event.reason==="new"));
  fs.unlinkSync(cancelMarker);
  const response = await rpc("new_session"); assert.equal(response.cancelled, false);
  const events = fs.readFileSync(lifecycle,"utf8").trim().split("\n").map(line => JSON.parse(line));
  const departed = events.find(e => e.type === "session_shutdown" && e.reason === "new");
  const arrived = events.find(e => e.type === "session_start" && e.reason === "new");
  assert(departed && arrived); assert.notEqual(departed.instance, arrived.instance); assert.notEqual(departed.nativeSessionId, arrived.nativeSessionId);
  assert.equal(departed.sessionFile, arrived.previousSessionFile); assert.equal(departed.targetSessionFile, arrived.sessionFile);
  const unknown = parseResult(await client.callTool({ name: "ce_endpoints", arguments: { previousEndpointId } })); assert.equal(unknown.sessionSwitch.status,"unknown");
  assert(!readLivePolicy(ref).manifest.registrations.some(r => r.runtimeSessionId === arrived.nativeSessionId), "new runtime inherited a grant");
  const successorEndpointId = `pi/dogfood-${randomUUID()}`;
  register(arrived.nativeSessionId, successorEndpointId);
  const found = parseResult(await client.callTool({ name: "ce_endpoints", arguments: { previousEndpointId } }));
  assert.equal(found.sessionSwitch.status,"verified"); assert.equal(found.sessionSwitch.successorEndpointId,successorEndpointId);
  assert.equal(found.sessionSwitch.source,"pi.new.lifecycle");
  assert.equal(JSON.stringify(store.database.prepare("SELECT * FROM message ORDER BY message_id").all()),messageBefore);
  assert.equal(JSON.stringify(store.database.prepare("SELECT * FROM delivery_ack_receipt").all()),receiptsBefore);
  const networkAttempts = fs.existsSync(attempts) ? fs.readFileSync(attempts,"utf8").trim().split("\n").filter(Boolean).length : 0;
  assert.equal(networkAttempts,0);
  evidence = { handoff:"HANDOFF-CE-SESSION-SWITCH-UX-01", verdict:"PASS", policyKind:ref.kind, root, piVersion:JSON.parse(fs.readFileSync(join(pkg,"node_modules/@earendil-works/pi-coding-agent/package.json"),"utf8")).version,
    mechanism:"real Pi CLI RPC new_session -> AgentSessionRuntime.newSession (same replacement implementation as TUI /new)",
    realPiPid:child.pid, realMcpPid:transport.pid, lifecycle:{departed,arrived}, queryBeforeIndependentGrant:unknown, queryAfterIndependentGrant:found,
    cancelledNewDidNotCreateRelation:true,
    existingMessageId:sent.messageId, existingMessageRowsUnchanged:true, ackRowsUnchanged:true, oldMessageCount:store.database.prepare("SELECT count(*) AS n FROM message").get().n,
    oldRowsSha256:createHash("sha256").update(messageBefore).digest("hex"), networkAttempts, taskReplayCount:0, productionConfigurationChanged:false,
    limitations:["Synthetic isolated Endpoint registration; no production rollout or ChatGPT cloud interaction.","The new Endpoint is send-authorized after explicit registration but not attached; discovery does not imply receipt.","No model request or automatic old-task ACK/replay."] };
} finally {
  await client.close().catch(()=>{});
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise(resolveExit => child.once("exit", resolveExit));
  child.stdin.end();
  const deadline = setTimeout(()=>child.kill("SIGTERM"),5000);
  await exited; clearTimeout(deadline); lines.close(); store.close();
  fs.writeFileSync(join(root,"pi-stderr.log"),stderr,{mode:0o600}); fs.writeFileSync(join(root,"mcp-stderr.log"),stderrMcp,{mode:0o600});
}
const output = process.argv[2]; assert(output && output.startsWith("/"),"absolute evidence output required");
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify({verdict:evidence.verdict,root,piVersion:evidence.piVersion,networkAttempts:evidence.networkAttempts,oldRowsUnchanged:true,successorEndpointId:evidence.queryAfterIndependentGrant.sessionSwitch.successorEndpointId}));
