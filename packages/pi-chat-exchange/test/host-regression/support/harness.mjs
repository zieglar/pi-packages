/** Opt-in REAL-HOST recovery regression harness (HANDOFF-CE-RELEASE-READINESS-01).
 *
 * Everything here runs against a throwaway private root under the OS temp dir:
 * a fresh HOME, PI_CODING_AGENT_DIR, session dir, TMPDIR and all four XDG dirs,
 * an allowlisted environment with no inherited `CE_*` or provider secrets, and a
 * SYNTHETIC loopback model provider so Pi's own code writes a genuine session
 * file without any credential or egress. The CE extension exercised is compiled
 * OUT-OF-TREE from `git archive HEAD`, so the worktree `dist` is never mutated
 * and the tested artifact is provably the committed HEAD.
 *
 * No real Tunnel/Session/Store/Exchange, no business message, read or ACK, no
 * Operator Recovery and no installed `tunnel-client` execution ever happens:
 * the Store is synthetic, the only peer is the synthetic `chatgpt/main` label,
 * and a child_process hook both accounts for and REFUSES any execution naming
 * tunnel-client.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

export const packageRoot = resolve(import.meta.dirname, "..", "..", "..");
export const repoRoot = resolve(packageRoot, "..", "..");
export const cliPath = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
export const driverPath = join(import.meta.dirname, "pty-driver.py");
/** Approved runtime only: the package engines contract (24.21.0 || 24.22.1). */
export const nodePath = process.env.CE_HOST_REGRESSION_NODE?.trim() || process.execPath;
const APPROVED = /^v(24\.21\.0|24\.22\.1)$/;

export const LEASE_TTL_SECONDS = 120;
export const RUNTIME_SESSION = "hr-A";
export const ENDPOINT_ID = "pi/hr-A";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Loud prerequisite guard. A missing prerequisite is a setup error, never a skip. */
export function assertPrerequisites() {
  const problems = [];
  if (!fs.existsSync(cliPath)) problems.push(`real Pi CLI not found at ${cliPath}`);
  if (!fs.existsSync(driverPath)) problems.push(`PTY driver not found at ${driverPath}`);
  const version = spawnSync(nodePath, ["-p", "process.version"], { encoding: "utf8" }).stdout?.trim();
  if (!APPROVED.test(String(version))) problems.push(`approved Node required (24.21.0 || 24.22.1), ${nodePath} reports ${version}`);
  for (const tool of ["git", "tar", "/usr/bin/python3"]) {
    const probe = tool.startsWith("/") ? spawnSync(tool, ["-V"], { encoding: "utf8" }) : spawnSync("which", [tool], { encoding: "utf8" });
    if (probe.status !== 0) problems.push(`required tool unavailable: ${tool}`);
  }
  if (problems.length > 0) {
    throw new Error(
      "real-host recovery regression prerequisites are absent; this is the opt-in " +
        "`pnpm run test:host-regression` lane (excluded from the default `pnpm test`), not a silent skip:\n  - " +
        problems.join("\n  - "),
    );
  }
  return { nodePath, cliPath, driverPath };
}

/** Fresh private root with every directory the host and the mutex chain need. */
export function prepareRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-host-regression-")));
  for (const dir of ["raw", "home/profile", "agent", "sessions", "cwd", "tmp", "trusted",
    "xdg-cache", "xdg-config", "xdg-data", "xdg-state", "src-HEAD"]) {
    fs.mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(root, 0o700);
  // The client path deliberately does NOT exist: discovery must fail closed and
  // the accounting hook refuses any execution that names tunnel-client anyway.
  const paths = {
    root,
    raw: join(root, "raw"),
    home: join(root, "home"),
    profile: join(root, "home", "profile", "tunnel.yaml"),
    bindings: join(root, "home", "profile", ".ce-bindings"),
    agent: join(root, "agent"),
    sessions: join(root, "sessions"),
    cwd: join(root, "cwd"),
    tmp: join(root, "tmp"),
    trustedClient: join(root, "trusted", "tunnel-client"),
    accountHook: join(root, "account.cjs"),
    accountLog: join(root, "raw", "children.jsonl"),
    providerState: join(root, "raw", "provider-state.json"),
    extract: join(root, "src-HEAD"),
    assertions: join(root, "raw", "assertions.jsonl"),
  };
  for (const key of ["xdg-cache", "xdg-config", "xdg-data", "xdg-state"]) paths[key] = join(root, key);
  // Deny-and-account hook installed into every node process of the host tree.
  fs.writeFileSync(paths.accountHook, [
    "const fs=require('node:fs'),cp=require('node:child_process');",
    "const base=(v)=>String(v).split('/').pop();",
    "for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){",
    "  const original=cp[method];",
    "  cp[method]=function(...a){",
    "    const options=a.find((v,i)=>i>0&&v&&typeof v==='object'&&!Array.isArray(v))||{};",
    "    const rec={time:new Date().toISOString(),pid:process.pid,method,command:a[0],args:Array.isArray(a[1])?a[1]:null,detached:options.detached===true};",
    "    const log=()=>fs.appendFileSync(process.env.HR_ACCOUNT,JSON.stringify(rec)+'\\n',{mode:0o600});",
    "    if(rec.detached||/^(setsid|nohup)$/.test(base(a[0]))){rec.outcome='unsupported-escape';log();throw Error('HR_UNSUPPORTED_ESCAPE');}",
    "    if(base(a[0]).includes('tunnel-client')||(typeof a[0]==='string'&&method.startsWith('exec')&&!Array.isArray(a[1])&&a[0].includes('tunnel-client'))){",
    "      rec.outcome='refused-client';log();throw Error('HR_NO_CLIENT_EXECUTION');}",
    "    try {const result=original.apply(this,a);rec.outcome='returned';rec.childPid=result?.pid??null;rec.status=result?.status??null;log();",
    "      if(result?.once) result.once('error',e=>{rec.outcome='spawn-error';rec.error=String(e);log();});return result;}",
    "    catch(e){rec.outcome='threw';rec.error=String(e);log();throw e;}",
    "  };",
    "}",
    "require('node:module').syncBuiltinESMExports();",
  ].join("\n"), { mode: 0o600 });
  return paths;
}

/** Extract HEAD out-of-tree and compile it there. The worktree is only read. */
export function buildFixedHead(paths) {
  const extract = paths.extract;
  const archive = join(paths.raw, "head.tar");
  fs.writeFileSync(archive, execFileSync("git", ["-C", repoRoot, "archive", "HEAD"], { maxBuffer: 1 << 26 }));
  execFileSync("tar", ["-x", "-f", archive, "-C", extract]);
  // Read-only reuse of the worktree's installed toolchain; nothing in the
  // worktree is written, and the compiled output lands only in the extract.
  fs.symlinkSync(resolve(repoRoot, "node_modules"), join(extract, "node_modules"), "dir");
  fs.symlinkSync(join(packageRoot, "node_modules"), join(extract, "packages", "pi-chat-exchange", "node_modules"), "dir");
  const extractPackage = join(extract, "packages", "pi-chat-exchange");
  const buildLog = join(paths.raw, "build.log");
  try {
    execFileSync(nodePath, [join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
      { cwd: extractPackage, stdio: ["ignore", fs.openSync(buildLog, "w"), fs.openSync(buildLog, "a")] });
  } catch (error) {
    throw new Error(`out-of-tree compile of HEAD failed; first preserved log at ${buildLog}: ${String(error)}`);
  }
  const identity = verifyHeadIdentity(extract);
  fs.writeFileSync(join(paths.raw, "identity.json"), JSON.stringify(identity, null, 2));
  if (identity.mismatches.length > 0 || identity.missing.length > 0 || identity.extra.length > 0) {
    throw new Error(`out-of-tree extract does not match HEAD blobs: ${JSON.stringify(identity)}`);
  }
  return {
    extensionPath: join(extractPackage, "pi-extension", "index.ts"),
    distRoot: join(extractPackage, "dist"),
    packageRoot: extractPackage,
    reconcileScript: join(extractPackage, "scripts", "reconcile-session-process-mutex.mjs"),
    identity,
  };
}

/** Every build input in the extract is compared to the HEAD Git blob identity. */
function verifyHeadIdentity(extract) {
  const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" }).trim();
  const pkg = "packages/pi-chat-exchange";
  const listing = execFileSync("git", ["-C", repoRoot, "ls-tree", "-r", "HEAD", "--",
    `${pkg}/src`, `${pkg}/pi-extension`, `${pkg}/scripts`, `${pkg}/bin`, `${pkg}/plugin`, `${pkg}/test`,
    `${pkg}/package.json`, `${pkg}/tsconfig.json`, `${pkg}/tsconfig.build.json`, `${pkg}/vitest.config.ts`, "tsconfig.base.json"],
    { encoding: "utf8", maxBuffer: 1 << 24 });
  const blobs = new Map();
  for (const line of listing.split("\n").filter(Boolean)) {
    const [meta, name] = line.split("\t");
    blobs.set(name, meta.split(" ")[2]);
  }
  const gitBlob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const dirtySources = execFileSync("git", ["-C", repoRoot, "status", "--porcelain", "--",
    `${pkg}/src`, `${pkg}/pi-extension`, `${pkg}/scripts`], { encoding: "utf8" }).trim();
  const report = { head, worktreeDirty: dirty, dirtySources, compared: 0, tracked: blobs.size, mismatches: [], missing: [], extra: [] };
  for (const [name, blob] of blobs) {
    const file = join(extract, name);
    if (!fs.existsSync(file)) { report.missing.push(name); continue; }
    report.compared += 1;
    if (gitBlob(fs.readFileSync(file)) !== blob) report.mismatches.push(name);
  }
  const present = new Set(["tsconfig.base.json"]);
  const walk = (relative) => {
    const absolute = join(extract, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next); else present.add(next);
    }
  };
  for (const dir of ["src", "pi-extension", "scripts", "bin", "plugin", "test"]) walk(`${pkg}/${dir}`);
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts"]) {
    if (fs.existsSync(join(extract, pkg, file))) present.add(`${pkg}/${file}`);
  }
  for (const file of present) if (!blobs.has(file)) report.extra.push(file);
  return report;
}

/** SYNTHETIC loopback model provider: 127.0.0.1 only, no credential in play. */
export async function startProvider(paths) {
  const state = (request) => {
    try {
      const document = JSON.parse(fs.readFileSync(paths.providerState, "utf8"));
      if (document.mode === "tool" && typeof document.tool === "string") return document;
    } catch { /* fall through to the inert default */ }
    return { mode: "text", note: `inert-default for ${request}` };
  };
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end(); return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const directive = state(body.length);
      const created = Math.floor(Date.now() / 1000);
      const frame = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id: `hr-${randomUUID()}`, object: "chat.completion.chunk", created, model: "stub-local" };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (directive.mode === "tool") {
        // Exactly ONE synthetic tool call per directive: the agent loop would
        // otherwise replay the call forever and never settle.
        try { fs.rmSync(paths.providerState); } catch { /* already inert */ }
        frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
          index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function",
          function: { name: directive.tool, arguments: JSON.stringify(directive.args ?? {}) } }] }, finish_reason: null }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic offline acknowledgement; no CE operation requested" }, finish_reason: null }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      frame({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      response.write("data: [DONE]\n\n");
      response.end();
      fs.appendFileSync(join(paths.raw, "provider-requests.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), mode: directive.mode, tool: directive.tool ?? null, bytes: body.length })}\n`);
    });
  });
  await new Promise((settled) => server.listen(0, "127.0.0.1", settled));
  const port = server.address().port;
  fs.writeFileSync(join(paths.agent, "models.json"), JSON.stringify({
    providers: {
      cesynthetic: {
        name: "CE synthetic offline stub",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "synthetic-not-a-credential",
        models: [{ id: "stub-local", name: "stub-local", contextWindow: 8192, maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(join(paths.agent, "auth.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(join(paths.agent, "settings.json"), JSON.stringify({ lastChangelogVersion: "1.3.0" }), { mode: 0o600 });
  return { server, port, close: () => new Promise((done, reject) => {
    server.close((error) => error ? reject(error) : done());
  }) };
}

export function setProviderDirective(paths, directive) {
  fs.writeFileSync(paths.providerState, JSON.stringify(directive, null, 2), { mode: 0o600 });
}

/** Allowlisted child environment: no inherited CE_* or provider secret. */
export function piEnvironment(paths, overrides = {}) {
  const environment = {
    HOME: paths.home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    TMPDIR: paths.tmp,
    PI_CODING_AGENT_DIR: paths.agent,
    PI_CODING_AGENT_SESSION_DIR: paths.sessions,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    XDG_CONFIG_HOME: paths["xdg-config"],
    XDG_DATA_HOME: paths["xdg-data"],
    XDG_CACHE_HOME: paths["xdg-cache"],
    XDG_STATE_HOME: paths["xdg-state"],
    CE_TUNNEL_PROFILE: paths.profile,
    CE_TUNNEL_CLIENT_PATH: paths.trustedClient,
    CE_NODE_PATH: nodePath,
    CE_LEASE_TTL_SECONDS: String(LEASE_TTL_SECONDS),
    NODE_OPTIONS: `--require=${paths.accountHook}`,
    HR_ACCOUNT: paths.accountLog,
  };
  return { ...environment, ...overrides };
}

export function piArgv(paths, built, { sessionId = RUNTIME_SESSION, resume } = {}) {
  const argv = [nodePath, cliPath, "--offline", "--no-mcp", "--no-skills", "--no-extensions",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--tui-mode", "regular", "--model", "cesynthetic/stub-local",
    "--extension", built.extensionPath, "--session-dir", paths.sessions, "--session-id", sessionId];
  if (resume !== undefined) argv.push("--resume", resume);
  return argv;
}

/** Publish the synthetic multi-session configuration with the REAL publication
 * code from the out-of-tree build: managed binding, messaging pair, profile and
 * the multi-session generation. Operator configuration only — no CE authority,
 * no Store rows, no transport lifecycle side effect. */
export async function publishConfiguration(paths, built) {
  const modules = {
    policy: await import(pathToFileURL(join(built.distRoot, "tunnel", "multi-session-policy.js")).href),
    profile: await import(pathToFileURL(join(built.distRoot, "tunnel", "profile.js")).href),
    binding: await import(pathToFileURL(join(built.distRoot, "tunnel", "managed-binding.js")).href),
    messaging: await import(pathToFileURL(join(built.distRoot, "tunnel", "messaging-config.js")).href),
    manager: await import(pathToFileURL(join(built.distRoot, "tunnel", "background-manager.js")).href),
  };
  const forbidden = () => { throw new Error("HR_FORBIDDEN_PROCESS_OPERATION"); };
  const processView = { kind: "ok", processes: [] }; // synthetic STOPPED transport
  const manager = modules.manager.createBackgroundTunnelManager({
    env: {}, profilePath: paths.profile, clientPath: "/nonexistent/tunnel-client",
    listProcesses: async () => processView,
    inspectProcess: async () => ({ kind: "absent" }),
    spawn: forbidden, signal: forbidden,
  });
  const keyFile = join(paths.bindings, "NEVER-READ-CREDENTIAL");
  const managed = modules.binding.ensureManagedBinding(paths.profile, {
    tunnelId: "tunnel_hrsynthetic0001", organizationId: undefined,
    adapter: "chatgpt", endpointId: "chatgpt/main",
    recipients: [{ adapter: "pi", endpointId: ENDPOINT_ID }],
    capabilities: { payloadRead: false, ack: false },
  });
  const legacyPair = modules.messaging.publishMessagingPair(paths.profile, managed.config, {
    chatgptEndpoint: managed.config.endpoint,
    piEndpoint: { adapter: "pi", endpointId: ENDPOINT_ID },
    piSessionId: RUNTIME_SESSION,
    store: managed.config.store,
    exchangeNamespace: managed.config.exchange.namespace,
    exchangeIdempotencyKey: managed.config.exchange.idempotencyKey,
    payloadRead: false, ack: false,
  });
  fs.writeFileSync(keyFile, "x".repeat(24), { mode: 0o600 });
  fs.writeFileSync(paths.profile, modules.profile.serializeTunnelProfile(modules.profile.buildTunnelProfile({
    tunnelId: "tunnel_hrsynthetic0001",
    keyFile,
    healthUrlFile: join(paths.bindings, "health.url"),
    mcpCommand: modules.profile.buildTunnelMcpCommand({
      nodePath, scriptPath: join(built.packageRoot, "dist", "bin", "mcp-stdio.js"),
      bindingPath: legacyPair.bindingPath,
    }),
  })), { mode: 0o600 });
  const api = modules.policy.createMultiSessionRegistration({ profilePath: paths.profile, manager });
  await api.convert({ expectedRevision: api.revision(), confirm: true });
  const registered = await api.register({ expectedRevision: api.revision(),
    registration: { endpointId: ENDPOINT_ID, runtimeSessionId: RUNTIME_SESSION, payloadRead: false, ack: false } });
  const snapshot = modules.policy.readSelectedMultiSessionPolicy(paths.profile);
  return { manager, api, modules, registered, snapshot, store: snapshot.manifest.store,
    registrations: snapshot.manifest.registrations };
}

/** Mid-flight admission narrowing: revoke this Endpoint's registration. */
export function revokeRegistration(publication) {
  return publication.api.revoke({ expectedRevision: publication.api.revision(), endpointId: ENDPOINT_ID });
}

/** Restore admission for the SAME runtime Session and Endpoint. Publication
 * rules bump the epoch of a revoked registration, so a fresh process loads an
 * active generation again while the old (still-running) process's captured
 * epoch stays denied. Operator configuration only; no CE authority touched. */
export function restoreRegistration(publication) {
  return publication.api.register({ expectedRevision: publication.api.revision(),
    registration: { endpointId: ENDPOINT_ID, runtimeSessionId: RUNTIME_SESSION, payloadRead: false, ack: false } });
}

// ---------------------------------------------------------------------------
// Read-only authority state capture.
// ---------------------------------------------------------------------------

export function captureAuthority(paths, label) {
  const out = { label, capturedAt: new Date().toISOString() };
  const bindingDir = paths.bindings;
  out.bindings = { entries: [] };
  if (fs.existsSync(bindingDir)) {
    for (const name of fs.readdirSync(bindingDir).sort()) {
      const file = join(bindingDir, name);
      const stat = fs.lstatSync(file);
      const entry = { name, mode: (stat.mode & 0o7777).toString(8), size: stat.size,
        sha256: stat.isFile() ? sha256(fs.readFileSync(file)) : null };
      if (stat.isFile() && name.endsWith(".pi-allowlist.json")) {
        try {
          const document = JSON.parse(fs.readFileSync(file, "utf8"));
          if (Array.isArray(document.registrations)) entry.registrations = document.registrations;
        } catch { entry.parse = "unreadable"; }
      }
      out.bindings.entries.push(entry);
    }
  }
  const storeFile = join(bindingDir, "ce-store.sqlite");
  out.store = { path: storeFile, exists: fs.existsSync(storeFile) };
  if (out.store.exists) {
    const stat = fs.lstatSync(storeFile);
    out.store.stat = { dev: stat.dev, ino: stat.ino, mode: (stat.mode & 0o7777).toString(8), size: stat.size };
    let db;
    try {
      db = new DatabaseSync(storeFile, { readOnly: true });
      const query = (sql) => { try { return db.prepare(sql).all(); } catch (error) { return [{ error: String(error.message ?? error) }]; } };
      out.participants = query("SELECT participant_id, endpoint_adapter, endpoint_id, created_at FROM participant ORDER BY endpoint_adapter, endpoint_id");
      out.ownership = query("SELECT participant_id, session_id, fencing_token, lease_started_at, expires_at, private_revision FROM participant_ownership ORDER BY participant_id");
      out.ownershipBytes = query("SELECT participant_id, quote(session_id) AS session_id, fencing_token, expires_at, private_revision FROM participant_ownership ORDER BY participant_id");
      out.fencingHighWater = query("SELECT participant_id, fencing_token FROM participant_fencing_high_water ORDER BY participant_id");
      out.sessionsBound = query("SELECT participant_id, session_id, bound_at, detached_at FROM participant_session ORDER BY participant_id, bound_at");
      out.messages = query("SELECT message_id, exchange_id, json_extract(from_endpoint_json,'$.endpointId') AS sender, json_extract(to_endpoint_json,'$.endpointId') AS recipient, state, idempotency_key, created_at FROM message ORDER BY created_at");
      out.auditEvents = query("SELECT event_id, sequence, kind, subject_id, outcome, created_at FROM audit_event ORDER BY sequence");
      const now = new Date().toISOString();
      out.leaseEvaluation = (out.ownership ?? []).filter((row) => !row.error).map((row) => ({
        participant_id: row.participant_id, session_id: row.session_id, fencing_token: row.fencing_token,
        expires_at: row.expires_at, lease_started_at: row.lease_started_at, now,
        lease: row.lease_started_at === null ? "EXPIRED"
          : Date.parse(now) >= Date.parse(row.expires_at) ? "EXPIRED"
            : Date.parse(now) < Date.parse(row.lease_started_at) ? "CLOCK_REGRESSION" : "ACTIVE",
        secondsPastExpiry: Math.round((Date.parse(now) - Date.parse(row.expires_at)) / 1000),
        secondsRemaining: Math.round((Date.parse(row.expires_at) - Date.parse(now)) / 1000),
      }));
    } catch (error) { out.store.openError = String(error.message ?? error); }
    finally { try { db?.close(); } catch { /* readonly */ } }
    const mutexRoot = join(bindingDir, ".ce-session-process-mutex");
    out.mutex = { root: mutexRoot, exists: fs.existsSync(mutexRoot), scopes: [] };
    if (out.mutex.exists) {
      for (const scope of fs.readdirSync(mutexRoot).sort()) {
        const entry = { scope, slots: [] };
        for (const slot of fs.readdirSync(join(mutexRoot, scope)).sort((a, b) => Number(a) - Number(b))) {
          const slotDir = join(mutexRoot, scope, slot);
          const stat = fs.lstatSync(slotDir);
          const record = { slot, files: {}, dir: { dev: stat.dev, ino: stat.ino } };
          for (const file of fs.readdirSync(slotDir).sort()) {
            const bytes = fs.readFileSync(join(slotDir, file));
            const fileStat = fs.lstatSync(join(slotDir, file));
            record.files[file] = { sha256: sha256(bytes), bytes: bytes.toString("utf8"), dev: fileStat.dev, ino: fileStat.ino };
          }
          record.released = "released.json" in record.files;
          record.receiptEqualsOwner = record.released && record.files["released.json"].sha256 === record.files["owner.json"].sha256;
          entry.slots.push(record);
        }
        out.mutex.scopes.push(entry);
      }
    }
  }
  out.piSessions = { dir: paths.sessions, files: [] };
  for (const name of fs.existsSync(paths.sessions) ? fs.readdirSync(paths.sessions).sort() : []) {
    const file = join(paths.sessions, name);
    const stat = fs.lstatSync(file);
    const record = { name, size: stat.size, mtime: stat.mtime.toISOString() };
    if (stat.isFile() && name.endsWith(".jsonl")) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      record.entryCount = lines.length;
      record.entryTypes = {};
      record.ceEntries = [];
      record.hasUserMessage = false;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const key = entry.type === "message" ? `message:${entry.message?.role}` : entry.type === "custom" ? `custom:${entry.customType}` : entry.type;
          record.entryTypes[key] = (record.entryTypes[key] ?? 0) + 1;
          if (key === "message:user") record.hasUserMessage = true;
          if (entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("ce-")) {
            record.ceEntries.push({ customType: entry.customType, data: entry.data });
          }
        } catch { record.entryTypes.unparsed = (record.entryTypes.unparsed ?? 0) + 1; }
      }
    }
    out.piSessions.files.push(record);
  }
  const destination = join(paths.raw, `authority-${label}.json`);
  fs.writeFileSync(destination, JSON.stringify(out, null, 2), { mode: 0o600 });
  out.file = destination;
  return out;
}

export function ownershipRow(snapshot) {
  return snapshot.ownership?.[0];
}

export function slotCount(snapshot) {
  return snapshot.mutex?.scopes?.flatMap((scope) => scope.slots).length ?? 0;
}

export function unreleasedSlots(snapshot) {
  return (snapshot.mutex?.scopes ?? []).flatMap((scope) => scope.slots).filter((slot) => !slot.released);
}

/** Independently confirm the owner is dead, exactly as the reconcile contract
 * demands (definitive `ps` "no such PID" evidence). */
export function deathEvidence(paths, pid, label) {
  const probe = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  const evidence = {
    pid, at: new Date().toISOString(), label,
    psStatus: probe.status, psStdout: probe.stdout ?? "", psStderr: probe.stderr ?? "",
    definitive: probe.status === 1 && (probe.stdout ?? "") === "" && (probe.stderr ?? "") === "",
  };
  fs.writeFileSync(join(paths.raw, `death-${label}.json`), JSON.stringify(evidence, null, 2));
  return evidence;
}

/** Derive the EXACT documented reconcile argv from independently captured state. */
export function deriveReconcileArguments(snapshot, store, death) {
  const scope = snapshot.mutex.scopes.find((entry) => entry.slots.some((slot) => !slot.released));
  if (scope === undefined) throw new Error("no unreleased mutex slot to reconcile");
  const slot = scope.slots.find((entry) => !entry.released);
  const owner = JSON.parse(slot.files["owner.json"].bytes);
  return [
    "--expect-store-dir", store.directory,
    "--expect-store-file", store.file,
    "--expect-endpoint", ENDPOINT_ID,
    "--expect-runtime-session", RUNTIME_SESSION,
    "--expect-slot", slot.slot,
    "--expect-owner-version", "1",
    "--expect-owner-scope", owner.scope,
    "--expect-owner-pid", String(owner.pid),
    "--expect-owner-birth", owner.birth,
    "--expect-owner-process-token", owner.processToken,
    "--expect-owner-handle-token", owner.handleToken,
    "--expect-owner-sha256", slot.files["owner.json"].sha256,
    "--expect-store-dev", String(snapshot.store.stat.dev),
    "--expect-store-ino", String(snapshot.store.stat.ino),
    "--expect-slot-dev", String(slot.dir.dev),
    "--expect-slot-ino", String(slot.dir.ino),
    "--expect-owner-dev", String(slot.files["owner.json"].dev),
    "--expect-owner-ino", String(slot.files["owner.json"].ino),
    "--offline-window-confirmed",
    "--owner-death-evidence", death,
  ];
}

export function runReconcile(paths, built, argv, label, driver) {
  // The owning driver serializes launch/exit controls. Recheck the CURRENT
  // launch at both ends of this synchronous offline window, never an old PID.
  const offlineBefore = driver.requireOffline();
  const meta = { argv, cwd: built.packageRoot, at: new Date().toISOString(), offlineBefore };
  const result = spawnSync(nodePath, [built.reconcileScript, ...argv], { cwd: built.packageRoot, encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: paths.tmp } });
  const offlineAfter = driver.requireOffline();
  if (JSON.stringify(offlineAfter) !== JSON.stringify(offlineBefore)) throw new Error("offline launch identity changed during reconciliation");
  const record = { ...meta, offlineAfter, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  fs.writeFileSync(join(paths.raw, `${label}.json`), JSON.stringify(record, null, 2));
  return record;
}

// ---------------------------------------------------------------------------
// PTY driver client.
// ---------------------------------------------------------------------------

export function startDriver(paths) {
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONUNBUFFERED: "1", TMPDIR: paths.tmp };
  const child = spawn("/usr/bin/python3", [driverPath, "--driver", paths.root], {
    stdio: ["ignore", "pipe", "pipe", "pipe"], env: environment });
  // Pass the driver's private write-channel peer ONLY to guardian. Node closes
  // its copy so no parent/workload descriptor can postpone driver-death EOF.
  const guardian = spawn("/usr/bin/python3", [driverPath, "--guardian", paths.root], {
    stdio: ["ignore", "pipe", "pipe", child.stdio[3]], env: environment });
  child.stdio[3].destroy();
  let stderr = "";
  for (const owned of [child, guardian]) owned.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const observe = (owned) => new Promise((settled, reject) => {
    owned.once("error", reject);
    owned.once("close", (code, signal) => settled({ code, signal }));
  });
  const exited = observe(child);
  const guardianExited = observe(guardian);
  let current;
  const matchesCurrent = (receipt) => current && receipt?.confirmed === true && receipt.groupDead === true &&
    receipt.anchorReaped === true && receipt.reaped === true && receipt.driverLost === false && receipt.anchorExit === -9 &&
    Number.isInteger(receipt.exit) && receipt.pid === current.pid && receipt.anchorPid === current.anchorPid &&
    receipt.pgid === current.pgid && receipt.generation === current.generation && receipt.guardianPid === guardian.pid &&
    JSON.stringify(receipt.events) === JSON.stringify(["final-group-kill", "no-live-members", "anchor-reaped"]) &&
    Array.isArray(receipt.members) && receipt.members.every((member) => member.dead === true && member.reaped === false);
  const guardianResult = async () => {
    const result = await bounded(guardianExited, 15_000, "guardian exit");
    const outcome = JSON.parse(fs.readFileSync(join(paths.raw, "guardian-outcome.json"), "utf8"));
    if (result.code !== 0 || outcome.successful !== true || outcome.driverLost !== false || outcome.guardianPid !== guardian.pid ||
        (current ? !matchesCurrent(outcome.barrier) || JSON.stringify(outcome.barrier) !==
          JSON.stringify(JSON.parse(fs.readFileSync(join(paths.raw, `barrier-${current.generation}.json`), "utf8"))) : outcome.barrier !== null)) {
      throw new Error(`guardian cleanup failed (${result.code}/${result.signal}): ${JSON.stringify(outcome)}; ${stderr}`);
    }
    return outcome;
  };
  let sequence = 0;
  const enqueue = (command) => {
    const stem = `control-${String(++sequence).padStart(3, "0")}`;
    const temporary = join(paths.raw, `${stem}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(command));
    fs.renameSync(temporary, join(paths.raw, `${stem}.json`));
    return stem;
  };
  const boundedExit = (ms) => bounded(exited, ms, "PTY driver exit");
  let stopping;
  const stop = () => stopping ??= (async () => {
    let stem;
    let result;
    try {
      if (child.exitCode === null && child.signalCode === null) stem = enqueue({ op: "stop" });
      result = await boundedExit(15_000);
    } catch (error) {
      // Publication errors belong to the SAME recovery scope as exit timeouts.
      // Do not settle/cache rejection until the owning driver's TERM handler
      // has had bounded time to reap its child. Never signal a saved numeric PID.
      const errors = [error];
      try {
        child.kill("SIGTERM");
        await boundedExit(10_000);
      } catch (termError) {
        errors.push(termError);
        try {
          child.kill("SIGKILL");
          await boundedExit(5_000);
        } catch (killError) { errors.push(killError); }
      }
      try { await guardianResult(); } catch (guardianError) { errors.push(guardianError); }
      if (errors.length > 1) throw new AggregateError(errors, "PTY driver fallback cleanup failed");
      throw error;
    }
    await guardianResult();
    if (result.code !== 0 || (stem && !fs.existsSync(join(paths.raw, `result-${stem}.json`)))) {
      throw new Error(`PTY driver exited without confirmed cleanup (${result.code}/${result.signal}): ${stderr}`);
    }
  })();
  const call = (command, waitSeconds = 0) => {
    const stem = enqueue(command);
    if (waitSeconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(waitSeconds * 1000));
    const deadline = Date.now() + 60_000;
    for (;;) {
      const answer = join(paths.raw, `result-${stem}.json`);
      if (fs.existsSync(answer)) {
        const result = JSON.parse(fs.readFileSync(answer, "utf8"));
        if (result.error) throw new Error(result.error);
        return result;
      }
      if (Date.now() > deadline) throw new Error(`PTY driver never answered ${stem}; driver stderr so far: ${stderr}`);
      if (fs.existsSync(join(paths.raw, "guardian-outcome.json")) || child.exitCode !== null || child.signalCode !== null || guardian.exitCode !== null || guardian.signalCode !== null) {
        throw new Error(`PTY driver/guardian exited early: ${stderr}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  };
  return {
    child, guardian,
    stderr: () => stderr,
    launch: (name, argv, environment, cwd, waitSeconds = 6) => {
      current = Object.freeze(call({ op: "launch", name, argv, env: environment, cwd }, waitSeconds));
      return current;
    },
    send: (text, waitSeconds = 3) => call({ op: "send", text }, waitSeconds),
    snapshot: () => call({ op: "snapshot" }),
    kill: () => call({ op: "kill" }),
    // Natural exit only. Timeout is a refusal, NOT permission to reconcile.
    awaitExit: (timeoutMs = 15_000) => call({ op: "await-exit", timeoutMs }),
    requireOffline: () => {
      const receipt = call({ op: "offline" });
      const persisted = JSON.parse(fs.readFileSync(join(paths.raw, `barrier-${current?.generation}.json`), "utf8"));
      if (!matchesCurrent(receipt) || JSON.stringify(persisted) !== JSON.stringify(receipt)) {
        throw new Error("offline group/guardian identity mismatch");
      }
      receipt.members.forEach(Object.freeze);
      Object.freeze(receipt.members);
      Object.freeze(receipt.events);
      return Object.freeze(receipt);
    },
    stop,
    /** Wait for a terminal predicate over the ANSI-stripped stream of `name`. */
    waitFor: async (name, predicate, timeoutMs, note) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = fs.existsSync(join(paths.raw, `${name}.txt`)) ? fs.readFileSync(join(paths.raw, `${name}.txt`), "utf8") : "";
        const matched = predicate(text);
        if (matched !== undefined && matched !== false) return { text, matched };
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${note ?? "terminal condition"}`);
        await new Promise((settled) => setTimeout(settled, 250));
      }
    },
  };
}

/** Local deadlines also cover provider callbacks that never settle. */
async function bounded(promise, ms, note) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${note} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Delete only after success AND cleanup AND recording. A failed recursive rm
 * can partially remove evidence: report the original root without promising
 * preservation. Recording/cleanup failures never authorize deletion. */
export async function finishRun(paths, driver, provider, { successful, keep = false }) {
  const errors = [];
  try { await driver?.stop(); } catch (error) { errors.push(error); }
  try {
    if (provider) await bounded(Promise.resolve().then(() => provider.close()), 5_000, "provider close");
  } catch (error) {
    errors.push(error);
    // Only this synthetic provider's server, never a global connection sweep.
    try { provider?.server?.closeAllConnections?.(); } catch (closeError) { errors.push(closeError); }
  }
  let retained = !successful || keep || errors.length > 0;
  let evidenceState = "retained";
  if (paths) {
    try {
      fs.writeFileSync(join(paths.raw, "cleanup.json"), JSON.stringify({
        successful, keep, retained, errors: errors.map(String), at: new Date().toISOString(),
      }, null, 2));
    } catch (error) { errors.push(error); retained = true; }
    if (!retained) {
      try { fs.rmSync(paths.root, { recursive: true }); evidenceState = "removed"; }
      catch (error) { errors.push(error); evidenceState = "possibly-partially-removed"; }
    }
    if (retained || errors.length > 0) {
      // Best effort even when evidence recording itself has failed.
      try { console.log(`real-host regression evidence ${evidenceState} at: ${paths.root}`); }
      catch (error) { errors.push(error); }
    }
  }
  if (errors.length > 0) {
    const error = new AggregateError(errors, `host regression cleanup failed; evidence ${evidenceState}`);
    error.evidence = { root: paths?.root, state: evidenceState };
    throw error;
  }
  return { retained };
}

export function terminalText(paths, name) {
  const file = join(paths.raw, `${name}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export function launchMeta(paths, name) {
  return JSON.parse(fs.readFileSync(join(paths.raw, `${name}.meta.json`), "utf8"));
}

/** Application-level accounting of every child_process call in the host tree. */
export function accounting(paths) {
  const file = paths.accountLog;
  const records = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
    : [];
  const byCommand = new Map();
  for (const record of records) {
    const key = String(record.command);
    byCommand.set(key, (byCommand.get(key) ?? 0) + 1);
  }
  const clientExecutions = records.filter((record) => String(record.command).includes("tunnel-client"));
  const summary = { total: records.length, distinctCommands: [...byCommand.entries()].sort(),
    tunnelClientExecutions: clientExecutions.length, tunnelClientRecords: clientExecutions,
    unsupportedEscapes: records.filter((record) => record.outcome === "unsupported-escape").length };
  fs.writeFileSync(join(paths.raw, "process-accounting-summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

/** Per-assertion evidence ledger; the test writes one row per required check. */
export function recordAssertion(paths, id, status, detail, evidence) {
  fs.appendFileSync(paths.assertions, `${JSON.stringify({ id, status, detail, evidence, at: new Date().toISOString() })}\n`);
}

export const sleep = (ms) => new Promise((settled) => setTimeout(settled, ms));

/** Wait until the durable lease remaining term enters a target band. */
export async function waitForLease(paths, predicate, timeoutMs, note) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = captureAuthority(paths, "poll");
    const lease = snapshot.leaseEvaluation?.[0];
    if (lease !== undefined && predicate(lease)) return { snapshot, lease };
    if (Date.now() > deadline) throw new Error(`timed out waiting for lease condition (${note}); last: ${JSON.stringify(lease)}`);
    await sleep(250);
  }
}
