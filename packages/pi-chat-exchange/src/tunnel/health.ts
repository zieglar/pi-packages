/**
 * HANDOFF-CE-HOST-09 B1 — parse official `tunnel-client health --json` output
 * into sanitized transport evidence.
 *
 * Provenance of the captured shapes (r2 correction, Lane A finding 7):
 * - PHASE-A-CLOSURE-RESULT V5/V6/V10 (healthy / daemon-gone shapes) were
 *   captured offline against `tunnel-client dev proxy` and remain accurate.
 * - V7 recorded a wrong-PID probe as "result fail, exit 0". The B1 rerun
 *   measured result "fail" with process.running false and exit code 2; the
 *   V7 "exit 0" was a measurement artifact of `... | tail` pipeline exit
 *   status. The parser keeps NO exit-code trust: both exit 0 and exit 2
 *   refuse Connected identically, and both cases are pinned by unit tests.
 *
 * Therefore the exit code is only a coarse reachability hint and must never be
 * read as health. `connectedEligible` requires the positive triple
 * (result ok + readyz.ok + healthz.body === "live"); anything else is refused,
 * including a PID cross-check failure (process.running false) even when
 * healthz/readyz still look good.
 * The parsed evidence intentionally carries no paths, no URLs (r2: the raw
 * ui_url string is validated down to a boolean exposure flag), and no raw
 * client text.
 */
export type HealthProbeKind = "healthy" | "unhealthy" | "unreachable" | "unverifiable";

export interface HealthCompletion {
  readonly runId: string;
  readonly managedPid: number;
  /** Strictly increasing within a run, assigned only at actual completion. */
  readonly sequence: number;
  readonly completedAt: number;
}

export interface HealthProbe {
  /** Parsing alone cannot attest to completion; unrecorded probes fail closed. */
  readonly completion?: HealthCompletion;
  readonly kind: HealthProbeKind;
  /** True only for the complete positive evidence triple. */
  readonly connectedEligible: boolean;
  /** True when `--require-control-plane-poll` evidence was present and ok. */
  readonly controlPlanePollObserved: boolean;
  /** Raw CLI exit code, retained for diagnostics only — never a health verdict. */
  readonly exitCode: number;
  /**
   * True when the client reported a ui_url AND it parses as a strictly
   * loopback http URL with no userinfo, query, or fragment, and path exactly
   * "/ui" (r2, Lane A finding 3: the raw URL string is never carried in
   * evidence because it could smuggle userinfo/query secrets).
   */
  readonly uiExposureLoopbackOnly: boolean;
}

export interface HealthProbeInput {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * One recorder per explicit supervised run. The future process adapter must
 * invoke this ONCE at probe completion, never on cached-result delivery/ticks.
 * No spawn, bus, file access, or implicit run allocation is performed here.
 */
export function createHealthCompletionRecorder(runId: string, managedPid: number, now: () => number): (input: HealthProbeInput) => HealthProbe {
  let sequence = 0;
  return (input) => {
    const completedAt = now();
    return Object.freeze({
      ...parseHealthProbe(input),
      completion: Object.freeze({ runId, managedPid, sequence: ++sequence, completedAt }),
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOOPBACK_UI_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?\/ui$/;

function isLoopbackUiUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return LOOPBACK_UI_URL.test(value);
}

function probe(
  kind: HealthProbeKind,
  exitCode: number,
  options: { connectedEligible?: boolean; controlPlanePollObserved?: boolean; uiExposureLoopbackOnly?: boolean } = {},
): HealthProbe {
  return Object.freeze({
    kind,
    connectedEligible: options.connectedEligible === true,
    controlPlanePollObserved: options.controlPlanePollObserved === true,
    exitCode,
    uiExposureLoopbackOnly: options.uiExposureLoopbackOnly === true,
  });
}

/**
 * Translate one probe invocation into evidence. Unparsable or structurally
 * unexpected output is `unverifiable` — never optimistically healthy.
 */
export function parseHealthProbe(input: HealthProbeInput): HealthProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    return probe("unverifiable", input.exitCode);
  }
  if (!isRecord(parsed)) return probe("unverifiable", input.exitCode);

  const locator = isRecord(parsed.locator) ? parsed.locator : undefined;
  const healthz = isRecord(parsed.healthz) ? parsed.healthz : undefined;
  const readyz = isRecord(parsed.readyz) ? parsed.readyz : undefined;
  const processBlock = isRecord(parsed.process) ? parsed.process : undefined;
  const result = parsed.result;
  const uiUrl = typeof parsed.ui_url === "string" ? parsed.ui_url : undefined;

  // The daemon is gone (or its locator vanished): the client deletes the
  // url-file on shutdown, so this is the authoritative "not reachable" shape.
  const locatorFailed = locator !== undefined && typeof locator.error === "string";
  const liveness = healthz?.ok === true;
  if (locatorFailed || (healthz !== undefined && healthz.ok === false && readyz?.ok !== true)) {
    return probe("unreachable", input.exitCode);
  }

  if (result !== "ok" && result !== "fail") return probe("unverifiable", input.exitCode);

  // A PID cross-check failure yields result "fail" (with process.running
  // false) while healthz/readyz still look good. The healthy-looking triple
  // must NOT rescue it: only result==="ok" with the full triple is eligible.
  const pidCheckFailed = processBlock !== undefined && processBlock.running === false;
  const pollEvidence = isRecord(parsed.control_plane_poll) ? parsed.control_plane_poll.ok === true : false;
  const eligible = result === "ok" && readyz?.ok === true && liveness && healthz?.body === "live" && !pidCheckFailed;

  return probe(eligible ? "healthy" : "unhealthy", input.exitCode, {
    ...(eligible ? { connectedEligible: true } : {}),
    ...(pollEvidence ? { controlPlanePollObserved: true } : {}),
    ...(isLoopbackUiUrl(uiUrl) ? { uiExposureLoopbackOnly: true } : {}),
  });
}
