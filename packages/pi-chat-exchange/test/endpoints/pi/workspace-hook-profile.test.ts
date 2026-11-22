import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cancelWorkspaceHookProfilePending, commitWorkspaceHookProfilePending, readWorkspaceHookAdoption, readWorkspaceHookProfile, readWorkspaceHookProfilePending, readWorkspaceHookProfileSnapshot, recordWorkspaceHookAdoption, reserveWorkspaceHookProfile, writeWorkspaceHookProfile } from "../../../pi-extension/workspace-hook-profile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-workspace-hooks-")));
  const a = join(root, "workspace-a");
  const b = join(root, "workspace-b");
  fs.mkdirSync(a); fs.mkdirSync(b); roots.push(root);
  const ref = { kind: "ce-live-session-v2", root, policyId: "policy", genesisDigest: "a".repeat(64), profilePath: join(root, "tunnel.yaml"), upgradeSequence: 1 } as const;
  const hooks = [{ id: "notify", event: "ce.message.committed.v1", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: false, scope: "workspace" }] as const;
  return { root, a, b, ref, hooks };
}

it("round-trips exact validated Hooks and isolates canonical workspaces", () => {
  const f = fixture();
  expect(readWorkspaceHookProfile(f.ref, f.a)).toBeUndefined();
  writeWorkspaceHookProfile(f.ref, f.a, f.hooks);
  expect(readWorkspaceHookProfile(f.ref, f.a)).toEqual(f.hooks);
  expect(readWorkspaceHookProfile(f.ref, f.b)).toBeUndefined();
});

it("persists an intentionally empty profile", () => {
  const f = fixture();
  writeWorkspaceHookProfile(f.ref, f.a, []);
  expect(readWorkspaceHookProfile(f.ref, f.a)).toEqual([]);
});

it("appends digest-linked revisions and rejects stale writers", () => {
  const f = fixture();
  const first = writeWorkspaceHookProfile(f.ref, f.a, f.hooks, { expectedRevision: 0 });
  expect(first).toMatchObject({ revision: 1, hooks: f.hooks });
  const second = writeWorkspaceHookProfile(f.ref, f.a, [], { expectedRevision: 1 });
  expect(second).toMatchObject({ revision: 2, hooks: [] });
  expect(readWorkspaceHookProfileSnapshot(f.ref, f.a)).toEqual(second);
  expect(() => writeWorkspaceHookProfile(f.ref, f.a, f.hooks, { expectedRevision: 1 })).toThrow("workspace Hook profile conflict");
});

it("accepts only workspace-scoped rules", () => {
  const f = fixture();
  expect(() => writeWorkspaceHookProfile(f.ref, f.a, [{ ...f.hooks[0]!, scope: "session" }])).toThrow("workspace Hook profile unavailable");
});

it("keeps UNKNOWN pending and commits only the exact published operation", () => {
  const f = fixture();
  const pending = reserveWorkspaceHookProfile(f.ref, f.a, { expectedRevision: 0, hooks: f.hooks, operationId: "op-1", actorRuntimeSessionId: "runtime-A", endpointId: "pi/A", epoch: 1, expectedPolicyDigest: "a".repeat(64) });
  expect(readWorkspaceHookProfilePending(f.ref, f.a)).toEqual(pending);
  expect(readWorkspaceHookProfile(f.ref, f.a)).toBeUndefined();
  expect(() => reserveWorkspaceHookProfile(f.ref, f.a, { ...pending, expectedRevision: 0, operationId: "op-2" })).toThrow("workspace Hook profile pending");
  expect(() => commitWorkspaceHookProfilePending(f.ref, f.a, { operationId: "op-2", publicationOutcome: "PUBLISHED", policyDigest: "b".repeat(64) })).toThrow();
  const committed = commitWorkspaceHookProfilePending(f.ref, f.a, { operationId: "op-1", publicationOutcome: "PUBLISHED", policyDigest: "b".repeat(64) });
  expect(committed).toMatchObject({ revision: 1, operationId: "op-1", hooks: f.hooks });
  expect(readWorkspaceHookProfilePending(f.ref, f.a)).toBeUndefined();
});

it("continues the exact pending operation after the revision record was synced before HEAD", () => {
  const f = fixture();
  reserveWorkspaceHookProfile(f.ref, f.a, { expectedRevision: 0, hooks: f.hooks, operationId: "op-crash", actorRuntimeSessionId: "runtime-A", endpointId: "pi/A", epoch: 1, expectedPolicyDigest: "a".repeat(64) });
  const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("lost before HEAD"); });
  expect(() => commitWorkspaceHookProfilePending(f.ref, f.a, { operationId: "op-crash", publicationOutcome: "PUBLISHED", policyDigest: "b".repeat(64) })).toThrow("lost before HEAD");
  rename.mockRestore();
  expect(commitWorkspaceHookProfilePending(f.ref, f.a, { operationId: "op-crash", publicationOutcome: "PUBLISHED", policyDigest: "b".repeat(64) })).toMatchObject({ revision: 1, operationId: "op-crash" });
});

it("cancels pending only with exact NOT_OBSERVED evidence", () => {
  const f = fixture();
  reserveWorkspaceHookProfile(f.ref, f.a, { expectedRevision: 0, hooks: f.hooks, operationId: "op-1", actorRuntimeSessionId: "runtime-A", endpointId: "pi/A", epoch: 1, expectedPolicyDigest: "a".repeat(64) });
  expect(() => cancelWorkspaceHookProfilePending(f.ref, f.a, { operationId: "op-1", publicationOutcome: "UNKNOWN" } as never)).toThrow();
  cancelWorkspaceHookProfilePending(f.ref, f.a, { operationId: "op-1", publicationOutcome: "NOT_OBSERVED" });
  expect(readWorkspaceHookProfilePending(f.ref, f.a)).toBeUndefined();
});

it("records exact Session adoption without changing the committed profile", () => {
  const f = fixture();
  const profile = writeWorkspaceHookProfile(f.ref, f.a, f.hooks);
  const adoption = { runtimeSessionId: "runtime-A", endpointId: "pi/A", epoch: 1, revision: profile.revision, profileDigest: profile.digest, policyDigest: "b".repeat(64), operationId: "adopt-1" };
  recordWorkspaceHookAdoption(f.ref, f.a, adoption);
  expect(readWorkspaceHookAdoption(f.ref, f.a, { runtimeSessionId: "runtime-A", endpointId: "pi/A", epoch: 1 })).toEqual(adoption);
  expect(readWorkspaceHookAdoption(f.ref, f.a, { runtimeSessionId: "runtime-B", endpointId: "pi/B", epoch: 1 })).toBeUndefined();
  expect(readWorkspaceHookProfileSnapshot(f.ref, f.a)).toEqual(profile);
});

it("refuses a malformed or workspace-mismatched profile", () => {
  const f = fixture();
  writeWorkspaceHookProfile(f.ref, f.a, f.hooks);
  const directory = join(f.root, "workspace-hook-profiles");
  const [name] = fs.readdirSync(directory);
  fs.writeFileSync(join(directory, name!, "HEAD.json"), JSON.stringify({ revision: 1, digest: "b".repeat(64) }), { mode: 0o600 });
  expect(() => readWorkspaceHookProfile(f.ref, f.a)).toThrow("workspace Hook profile unavailable");
});
