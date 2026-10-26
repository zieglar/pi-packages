import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

// Fault-detection lane for the durable-state predicates the heavy installed-host
// smoke relies on (first-run must be proven by on-disk state, not PTY strings).
// Everything here is a throwaway synthetic fixture: no host, no client, no
// network, no real profile/Store. A tampered fixture MUST be refused while the
// well-formed control passes — otherwise the predicates are decorative.
const verifier = new URL("./support/durable_state.py", import.meta.url).pathname;
const SYNTHETIC_KEY = "distribution-fixture-not-a-real-key";
const SESSION_ID = "01234567-89ab-7cde-8f01-234567890abc";
const ENDPOINT = "pi/distribution";
const TUNNEL_ID = "tunnel_Distribution01";
const STORE_TABLES = ["store_metadata", "schema_migrations", "restore_hold", "exchange", "message", "attempt", "current_claim", "fencing_high_water", "result", "idempotency_record", "evidence_envelope", "evidence_application", "reconciliation", "disposition", "audit_event", "participant", "participant_capability", "participant_session", "exchange_membership", "participant_ownership", "participant_fencing_high_water", "delivery_cursor", "host_trust_root", "delivery_ack_receipt"];

interface Facts {
  profileDir: string;
  tunnelId: string;
  credential: string;
  nodePath: string;
  mcpScript: string;
  endpoint: string;
  sessionId: string;
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function privateFile(path: string, content: string, mode = 0o600): void {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function storeAt(path: string, tables: string[]): void {
  const script = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path)});for(const t of ${JSON.stringify(tables)})db.exec('CREATE TABLE "'+t+'" (id INTEGER PRIMARY KEY)');db.close();`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
  chmodSync(path, 0o600);
}

function fixture(tables = STORE_TABLES): { root: string; facts: Facts } {
  const root = mkdtempSync(join(tmpdir(), "ce-durable-"));
  dirs.push(root);
  const profileDir = join(root, "profile");
  const bindings = join(profileDir, ".ce-bindings");
  for (const path of [profileDir, join(profileDir, ".credentials"), bindings, join(bindings, ".ce-session-process-mutex", scopeFor(bindings), "1")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const keyFile = join(profileDir, ".credentials", "credential-fixed-id");
  const binding = join(bindings, "messaging-placeholder.yaml");
  const mcpScript = join(root, "node_modules", "@zieglar", "pi-chat-exchange", "dist", "bin", "mcp-stdio.js");
  mkdirSync(join(mcpScript, ".."), { recursive: true });
  cpSync(new URL("../../dist/", import.meta.url), join(mcpScript, "../.."), { recursive: true });
  cpSync(new URL("../../node_modules/@sinclair/typebox/", import.meta.url), join(root, "node_modules/@sinclair/typebox"), { recursive: true, dereference: true });
  privateFile(keyFile, SYNTHETIC_KEY);
  privateFile(binding, "{}\n");
  privateFile(join(profileDir, "tunnel.yaml"), [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${TUNNEL_ID}"`,
    `  api_key: "file:${keyFile}"`,
    "health:",
    '  listen_addr: "127.0.0.1:0"',
    `  url_file: "${join(profileDir, "health.url")}"`,
    "admin_ui:",
    "  open_browser: false",
    "harpoon:",
    "  capture_payloads: false",
    "log:",
    "  level: info",
    "  format: json",
    "  http_raw_unsafe: false",
    "mcp:",
    "  commands:",
    "    - channel: main",
    `      command: "${process.execPath} ${mcpScript} --config ${binding}"`,
    "",
  ].join("\n"));
  const slot = join(bindings, ".ce-session-process-mutex", scopeFor(bindings), "1");
  const token = { version: 1, scope: scopeFor(bindings), pid: process.pid, birth: "Mon Oct 26 12:00:00 2026", processToken: "proc-token", handleToken: "handle-token" };
  privateFile(join(slot, "owner.json"), JSON.stringify(token));
  privateFile(join(slot, "released.json"), JSON.stringify(token));
  storeAt(join(bindings, "ce-store.sqlite"), tables);
  const state = { root, facts: { profileDir, tunnelId: TUNNEL_ID, credential: SYNTHETIC_KEY, nodePath: process.execPath, mcpScript, endpoint: ENDPOINT, sessionId: SESSION_ID } };
  selectGeneration(state);
  rmSync(binding);
  return state;
}

function scopeFor(bindings: string): string {
  return createHash("sha256").update(JSON.stringify([bindings, "ce-store.sqlite", ENDPOINT, SESSION_ID])).digest("hex");
}

// Real immutable pair format/digest, including all production parser fields.
function selectGeneration(state: { facts: Facts }, fault = ""): string {
  const profile = join(state.facts.profileDir, "tunnel.yaml");
  const bindings = join(state.facts.profileDir, ".ce-bindings");
  const store = { directory: bindings, file: "ce-store.sqlite" };
  const exchange = { namespace: "fixture", idempotencyKey: "fixture" };
  const endpoint = { adapter: "chatgpt", endpointId: "chatgpt/main" };
  const registrations = [{ endpointId: fault === "missing-registration" ? "pi/other" : ENDPOINT, runtimeSessionId: SESSION_ID, payloadRead: false, ack: false, epoch: 1, status: "active" }];
  const config = { version: 1, store, exchange, endpoint, recipients: registrations.map((r) => ({ adapter: "pi", endpointId: r.endpointId })), lease: { ttlSeconds: 120, renewIntervalSeconds: 30 }, payloadRead: { enabled: false }, ack: { enabled: false }, debugExecutionGuard: { enabled: false }, managed: { tunnelId: TUNNEL_ID, adapter: "chatgpt" }, admissionPolicy: { kind: "ce-multi-session-v1", profilePath: profile } };
  const manifest = { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: fault === "wrong-identity" ? "tunnel_Foreign001" : TUNNEL_ID, organizationId: null }, store, exchange, chatgptEndpoint: endpoint, mcp: { payloadRead: false, ack: false }, registrations };
  const bindingBytes = JSON.stringify(fault === "corrupt-binding" ? {} : fault === "wrong-store" ? { ...config, store: { ...store, file: "other.sqlite" } } : config);
  const manifestBytes = JSON.stringify(manifest);
  const digest = createHash("sha256").update(bindingBytes).update("\0").update(manifestBytes).digest("hex");
  const binding = join(bindings, `messaging-${digest}.yaml`);
  privateFile(binding, bindingBytes);
  privateFile(`${binding}.pi-allowlist.json`, manifestBytes);
  const text = readFileSync(profile, "utf8").replace(/--config [^"\n]+/, `--config ${binding}`);
  privateFile(profile, text);
  return binding;
}

function verify(mode: string, state: { root: string; facts: Facts }, override?: Partial<Facts>) {
  const expectPath = join(state.root, "expect.json");
  writeFileSync(expectPath, JSON.stringify({ ...state.facts, ...override }));
  return spawnSync("/usr/bin/python3", ["-B", verifier, mode, expectPath], { encoding: "utf8", timeout: 120_000 });
}

it("accepts the well-formed control fixture for every durable predicate", () => {
  const state = fixture();
  for (const mode of ["profile", "policy", "mutex", "store"]) {
    const result = verify(mode, state);
    expect(result.status, `${mode}: ${result.stderr}`).toBe(0);
  }
});

it("refuses a profile/credential permission or plaintext-credential fault", () => {
  const state = fixture();
  const profilePath = join(state.facts.profileDir, "tunnel.yaml");
  chmodSync(profilePath, 0o644);
  let result = verify("profile", state);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("mode");
  const state2 = fixture();
  const profilePath2 = join(state2.facts.profileDir, "tunnel.yaml");
  privateFile(profilePath2, `${readFileSync(profilePath2, "utf8")}# leak: ${SYNTHETIC_KEY}\n`);
  result = verify("profile", state2);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("plaintext");
});

it("refuses an unregistered endpoint or a foreign runtime-session binding", () => {
  const state = fixture();
  let result = verify("policy", state, { endpoint: "pi/never-registered" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("no durable registration");
  result = verify("policy", state, { sessionId: "ffffffff-ffff-7fff-8fff-ffffffffffff" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("different runtime session");
});

it("refuses an unreleased mutex or a token mismatch between owner and released", () => {
  const state = fixture();
  rmSync(join(state.facts.profileDir, `.ce-bindings/.ce-session-process-mutex/${scopeFor(join(state.facts.profileDir, ".ce-bindings"))}/1/released.json`));
  let result = verify("mutex", state);
  expect(result.status).not.toBe(0);
  const state2 = fixture();
  const releasedPath = join(state2.facts.profileDir, `.ce-bindings/.ce-session-process-mutex/${scopeFor(join(state2.facts.profileDir, ".ce-bindings"))}/1/released.json`);
  const token = JSON.parse(readFileSync(releasedPath, "utf8"));
  privateFile(releasedPath, JSON.stringify({ ...token, handleToken: "TAMPERED" }));
  result = verify("mutex", state2);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("handleToken");
});

it.each(["missing-registration", "corrupt-binding", "wrong-identity", "wrong-store"])("refuses selected %s even when an old generation is valid", (fault) => {
  const state = fixture();
  selectGeneration(state, fault); // leaves the valid old pair intact, but unselected
  const result = verify("policy", state);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain(fault === "missing-registration" ? "no durable registration" : "selected policy/binding invalid");
});

it.each(["scope", "birth", "processToken", "handleToken", "pid", "version"])("refuses paired mutex records both missing %s", (field) => {
  const state = fixture();
  const slot = join(state.facts.profileDir, ".ce-bindings/.ce-session-process-mutex", scopeFor(join(state.facts.profileDir, ".ce-bindings")), "1");
  for (const name of ["owner.json", "released.json"]) {
    const record = JSON.parse(readFileSync(join(slot, name), "utf8"));
    delete record[field];
    privateFile(join(slot, name), JSON.stringify(record));
  }
  expect(verify("mutex", state).status).not.toBe(0);
});

it.each(["scope", "birth", "processToken", "handleToken", "pid", "version"])("refuses paired mutex records with invalid %s types/values", (field) => {
  const state = fixture();
  const slot = join(state.facts.profileDir, ".ce-bindings/.ce-session-process-mutex", scopeFor(join(state.facts.profileDir, ".ce-bindings")), "1");
  for (const name of ["owner.json", "released.json"]) {
    const record = JSON.parse(readFileSync(join(slot, name), "utf8"));
    privateFile(join(slot, name), JSON.stringify({ ...record, [field]: field === "pid" || field === "version" ? true : "" }));
  }
  expect(verify("mutex", state).status).not.toBe(0);
});

it("refuses a release receipt missing its own version", () => {
  const state = fixture();
  const path = join(state.facts.profileDir, ".ce-bindings/.ce-session-process-mutex", scopeFor(join(state.facts.profileDir, ".ce-bindings")), "1/released.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  delete record.version;
  privateFile(path, JSON.stringify(record));
  expect(verify("mutex", state).status).not.toBe(0);
});

it("refuses paired mutex records associated with a different scope", () => {
  const state = fixture();
  const slot = join(state.facts.profileDir, ".ce-bindings/.ce-session-process-mutex", scopeFor(join(state.facts.profileDir, ".ce-bindings")), "1");
  for (const name of ["owner.json", "released.json"]) {
    const record = JSON.parse(readFileSync(join(slot, name), "utf8"));
    privateFile(join(slot, name), JSON.stringify({ ...record, scope: "foreign" }));
  }
  expect(verify("mutex", state).status).not.toBe(0);
});

it.each([false, true])("removes only its own read-only Store copy (corrupt=%s)", (corrupt) => {
  const state = fixture();
  if (corrupt) privateFile(join(state.facts.profileDir, ".ce-bindings/ce-store.sqlite"), "not sqlite");
  const tmp = join(state.root, "tmp");
  mkdirSync(tmp);
  const sentinel = join(tmp, "ce-store-copy-not-owned");
  mkdirSync(sentinel);
  privateFile(join(sentinel, "keep"), "untouched");
  const expectPath = join(state.root, "expect.json");
  writeFileSync(expectPath, JSON.stringify(state.facts));
  const result = spawnSync("/usr/bin/python3", ["-B", verifier, "store", expectPath], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: state.root, TMPDIR: tmp }, timeout: 120_000 });
  expect(result.status).toBe(corrupt ? 1 : 0);
  if (corrupt) expect(result.stderr).toContain("read-only");
  expect(readdirSync(tmp)).toEqual(["ce-store-copy-not-owned"]);
  expect(readFileSync(join(sentinel, "keep"), "utf8")).toBe("untouched");
});

it("refuses an incomplete synthetic Store schema", () => {
  const state = fixture(["store_metadata", "message", "participant"]);
  const result = verify("store", state);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("schema incomplete");
});
