/**
 * HANDOFF-CE-HOST-09 B1 — health evidence parsing.
 *
 * Fixtures are shapes captured offline from `tunnel-client dev proxy` (B1
 * re-capture; see src/tunnel/health.ts for provenance and the Phase A V7
 * pipeline-exit-code measurement artifact)
 * (PHASE-A-CLOSURE-RESULT V5/V6/V7/V10). The decisive, counter-intuitive case
 * is pinned here: a PID cross-check failure yields `result: "fail"` while the
 * process exit code must therefore never be read as
 * health. Connected evidence requires result==="ok", readyz.ok, and
 * healthz.body==="live".
 */
import { describe, expect, it } from "vitest";
import { parseHealthProbe } from "../../src/tunnel/health.js";

const OK_JSON = JSON.stringify({
  locator: { kind: "url_file", url_file: "/tmp/health.url", resolved_base_url: "http://127.0.0.1:65441" },
  base_url: "http://127.0.0.1:65441",
  ui_url: "http://127.0.0.1:65441/ui",
  healthz: { url: "http://127.0.0.1:65441/healthz", ok: true, status: 200, body: "live" },
  readyz: { url: "http://127.0.0.1:65441/readyz", ok: true, status: 200, body: "ready" },
  result: "ok",
});

const OK_WITH_POLL_JSON = JSON.stringify({
  ...JSON.parse(OK_JSON),
  control_plane_poll: { ok: true, observed_at: "2026-10-18T11:42:36Z" },
});

/** Real counter-example (re-captured in B1 against a live dev proxy):
 * wrong --pid yields result "fail" with process.running=false while healthz
 * and readyz still look good. The CLI exits non-zero, but the trap is that
 * the healthy-looking triple could rescue it if the parser trusted it. */
const PID_MISMATCH_JSON = JSON.stringify({
  locator: { kind: "url_file", url_file: "/tmp/health.url", resolved_base_url: "http://127.0.0.1:65441" },
  process: { pid: 999999, running: false },
  base_url: "http://127.0.0.1:65441",
  ui_url: "http://127.0.0.1:65441/ui",
  healthz: { ok: true, status: 200, body: "live" },
  readyz: { ok: true, status: 200, body: "ready" },
  result: "fail",
});

/** Daemon gone: the client deletes the url-file; CLI exits 2. */
const DAEMON_GONE_JSON = JSON.stringify({
  locator: { kind: "url_file", url_file: "/tmp/health.url", error: "open /tmp/health.url: no such file or directory" },
  healthz: { ok: false },
  readyz: { ok: false },
  result: "fail",
});

describe("parseHealthProbe", () => {
  it("accepts the captured healthy shape as Connected-eligible", () => {
    const probe = parseHealthProbe({ stdout: OK_JSON, exitCode: 0 });
    expect(probe.kind).toBe("healthy");
    expect(probe.connectedEligible).toBe(true);
    // r2: the raw ui_url string must NOT be carried in evidence; only a
    // validated boolean loopback-exposure flag survives.
    expect(probe.uiExposureLoopbackOnly).toBe(true);
    expect(JSON.stringify(probe)).not.toContain("65441");
    expect(JSON.stringify(probe)).not.toContain("/ui");
  });

  it("carries the control-plane poll gate when requested", () => {
    const probe = parseHealthProbe({ stdout: OK_WITH_POLL_JSON, exitCode: 0 });
    expect(probe.connectedEligible).toBe(true);
    expect(probe.controlPlanePollObserved).toBe(true);
  });

  it("REFUSES Connected when the PID cross-check fails (healthy triple present, result fail)", () => {
    const probe = parseHealthProbe({ stdout: PID_MISMATCH_JSON, exitCode: 2 });
    expect(probe.connectedEligible).toBe(false);
    expect(probe.kind).toBe("unhealthy");
    // The exit code is retained for diagnostics only.
    expect(probe.exitCode).toBe(2);
  });

  it("REFUSES Connected when result=fail regardless of an ok-looking exit code", () => {
    const same = JSON.parse(PID_MISMATCH_JSON) as Record<string, unknown>;
    const probe = parseHealthProbe({ stdout: JSON.stringify(same), exitCode: 0 });
    expect(probe.connectedEligible).toBe(false);
  });

  it("classifies a deleted url-file / absent daemon as unreachable", () => {
    const probe = parseHealthProbe({ stdout: DAEMON_GONE_JSON, exitCode: 2 });
    expect(probe.kind).toBe("unreachable");
    expect(probe.connectedEligible).toBe(false);
  });

  it("refuses Connected when healthz.body is not live", () => {
    const mutated = JSON.parse(OK_JSON) as Record<string, unknown>;
    (mutated.healthz as Record<string, unknown>).body = "draining";
    const probe = parseHealthProbe({ stdout: JSON.stringify(mutated), exitCode: 0 });
    expect(probe.connectedEligible).toBe(false);
  });

  it("refuses Connected when readyz is not ok", () => {
    const mutated = JSON.parse(OK_JSON) as Record<string, unknown>;
    (mutated.readyz as Record<string, unknown>).ok = false;
    const probe = parseHealthProbe({ stdout: JSON.stringify(mutated), exitCode: 0 });
    expect(probe.connectedEligible).toBe(false);
    expect(probe.kind).toBe("unhealthy");
  });

  it("treats unparsable output as unverifiable, never as healthy", () => {
    const probe = parseHealthProbe({ stdout: "not json", exitCode: 0 });
    expect(probe.kind).toBe("unverifiable");
    expect(probe.connectedEligible).toBe(false);
  });

  it("treats a zero-exit empty probe as unverifiable", () => {
    const probe = parseHealthProbe({ stdout: "", exitCode: 0 });
    expect(probe.kind).toBe("unverifiable");
    expect(probe.connectedEligible).toBe(false);
  });

  it("never exposes raw probe text on the parsed evidence", () => {
    const probe = parseHealthProbe({ stdout: OK_JSON, exitCode: 0 });
    expect(JSON.stringify(probe)).not.toContain("url_file");
  });
});
