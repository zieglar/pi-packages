import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  disableNativeInboundPolicy,
  enableNativeInboundPolicy,
  inspectNativeInboundPolicy,
  nativeInboundPolicyPath,
} from "../../../pi-extension/native-inbound-policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-inbound-policy-")));
  roots.push(root); fs.chmodSync(root, 0o700);
  const profilePath = join(root, "tunnel.yaml");
  fs.writeFileSync(profilePath, "profile", { mode: 0o600 });
  const identity = { runtimeSessionId: "session-A", endpointId: "pi/A", exchangeId: "exchange-A" } as const;
  return { root, profilePath, identity, path: nativeInboundPolicyPath(profilePath, identity.runtimeSessionId) };
}

it("creates a current-Session enabled policy at a safe atomic path", () => {
  const f = fixture();
  expect(inspectNativeInboundPolicy(f.path, f.identity, Date.parse("2026-11-16T01:00:00Z"))).toEqual({ status: "missing" });
  const policy = enableNativeInboundPolicy({ path: f.path, identity: f.identity, from: "chatgpt/main", afterAuditSequence: 396, now: Date.parse("2026-11-16T01:00:00Z") });
  expect(policy).toMatchObject({ enabled: true, ...f.identity, from: "chatgpt/main", afterAuditSequence: 396, maxAgeSeconds: 300 });
  expect(fs.statSync(join(f.profilePath + ".native-inbound")).mode & 0o777).toBe(0o700);
  expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
  expect(inspectNativeInboundPolicy(f.path, f.identity, Date.parse("2026-11-16T01:00:01Z"))).toMatchObject({ status: "enabled", policy });
  expect(fs.readdirSync(join(f.profilePath + ".native-inbound"))).toEqual([f.path.split("/").at(-1)]);
});

it("disables only the matching current-Session policy without deleting it", () => {
  const f = fixture();
  const enabled = enableNativeInboundPolicy({ path: f.path, identity: f.identity, from: "chatgpt/main", afterAuditSequence: 400, now: Date.parse("2026-11-16T01:00:00Z") });
  const disabled = disableNativeInboundPolicy({ path: f.path, identity: f.identity, now: Date.parse("2026-11-16T01:00:01Z") });
  expect(disabled).toEqual({ ...enabled, enabled: false });
  expect(fs.existsSync(f.path)).toBe(true);
  expect(inspectNativeInboundPolicy(f.path, f.identity, Date.parse("2026-11-16T01:00:01Z"))).toMatchObject({ status: "disabled", policy: disabled });
});

it("fails closed for identity drift, links, unsafe permissions and invalid sender or boundary", () => {
  const f = fixture();
  expect(() => enableNativeInboundPolicy({ path: f.path, identity: f.identity, from: "", afterAuditSequence: 1, now: Date.now() })).toThrow("INBOUND_POLICY_INVALID");
  expect(() => enableNativeInboundPolicy({ path: f.path, identity: f.identity, from: "chatgpt/main", afterAuditSequence: -1, now: Date.now() })).toThrow("INBOUND_POLICY_INVALID");
  enableNativeInboundPolicy({ path: f.path, identity: f.identity, from: "chatgpt/main", afterAuditSequence: 1, now: Date.now() });
  expect(inspectNativeInboundPolicy(f.path, { ...f.identity, endpointId: "pi/B" }, Date.now())).toEqual({ status: "invalid", code: "INBOUND_POLICY_INVALID" });
  fs.chmodSync(f.path, 0o644);
  expect(inspectNativeInboundPolicy(f.path, f.identity, Date.now())).toEqual({ status: "invalid", code: "INBOUND_POLICY_INVALID" });
  fs.rmSync(f.path); fs.symlinkSync(f.profilePath, f.path);
  expect(inspectNativeInboundPolicy(f.path, f.identity, Date.now())).toEqual({ status: "invalid", code: "INBOUND_POLICY_INVALID" });
});
