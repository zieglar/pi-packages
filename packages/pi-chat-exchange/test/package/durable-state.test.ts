import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const path of [profileDir, join(profileDir, ".credentials"), bindings, join(bindings, ".ce-session-process-mutex", "scope1", "1")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const keyFile = join(profileDir, ".credentials", "credential-fixed-id");
  const binding = join(bindings, "ce-tion01-none.yaml");
  const mcpScript = join(root, "node_modules", "@zieglar", "pi-chat-exchange", "dist", "bin", "mcp-stdio.js");
  mkdirSync(join(mcpScript, ".."), { recursive: true });
  privateFile(mcpScript, "// synthetic entry\n");
  privateFile(keyFile, SYNTHETIC_KEY);
  privateFile(binding, "{}\n");
  privateFile(join(profileDir, "tunnel.yaml"), [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${TUNNEL_ID}"`,
    `  api_key: "file:${keyFile}"`,
    "mcp:",
    "  commands:",
    "    - channel: main",
    `      command: "${process.execPath} ${mcpScript} --config ${binding}"`,
    "",
  ].join("\n"));
  const allowlist = join(bindings, "messaging-fixed.yaml");
  privateFile(allowlist, "{}\n");
  privateFile(`${allowlist}.pi-allowlist.json`, JSON.stringify({ registrations: [
    { endpointId: ENDPOINT, runtimeSessionId: SESSION_ID, payloadRead: false, ack: false, epoch: 1, status: "active" },
  ] }));
  const slot = join(bindings, ".ce-session-process-mutex", "scope1", "1");
  const token = { version: 1, scope: "scope1", pid: process.pid, birth: "now", processToken: "proc-token", handleToken: "handle-token" };
  privateFile(join(slot, "owner.json"), JSON.stringify(token));
  privateFile(join(slot, "released.json"), JSON.stringify(token));
  storeAt(join(bindings, "ce-store.sqlite"), tables);
  return { root, facts: { profileDir, tunnelId: TUNNEL_ID, credential: SYNTHETIC_KEY, nodePath: process.execPath, mcpScript, endpoint: ENDPOINT, sessionId: SESSION_ID } };
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
  rmSync(join(state.facts.profileDir, ".ce-bindings/.ce-session-process-mutex/scope1/1/released.json"));
  let result = verify("mutex", state);
  expect(result.status).not.toBe(0);
  const state2 = fixture();
  const releasedPath = join(state2.facts.profileDir, ".ce-bindings/.ce-session-process-mutex/scope1/1/released.json");
  privateFile(releasedPath, JSON.stringify({ version: 1, scope: "scope1", pid: process.pid, birth: "now", processToken: "proc-token", handleToken: "TAMPERED" }));
  result = verify("mutex", state2);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("handleToken");
});

it("refuses an incomplete synthetic Store schema", () => {
  const state = fixture(["store_metadata", "message", "participant"]);
  const result = verify("store", state);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("schema incomplete");
});
