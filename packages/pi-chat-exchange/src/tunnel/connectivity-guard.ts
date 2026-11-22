export type ConnectivityState = "CONNECTED" | "DEGRADED" | "DISCONNECTED" | "UNKNOWN";

export interface ConnectivityEvidence {
  readonly tunnelProcess: "RUNNING" | "STOPPED" | "UNKNOWN";
  readonly tunnelHealth: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  readonly mcpProcess: "RUNNING" | "STOPPED" | "UNKNOWN";
  readonly sessionBinding: "attached" | "detached" | "unknown";
}

export interface ConnectivityClassification {
  readonly state: ConnectivityState;
  readonly reason: string;
}

export interface ConnectivitySnapshot extends ConnectivityClassification {
  readonly consecutiveFailures: number;
  readonly lastSuccessAt?: number;
  readonly lastFailureAt?: number;
  readonly lastFailureReason?: string;
}

export type ConnectivityNotice =
  | { readonly kind: "failure"; readonly state: "DEGRADED" | "DISCONNECTED"; readonly reason: string; readonly lastSuccessAt?: number }
  | { readonly kind: "recovery"; readonly state: "CONNECTED"; readonly reason: "CE_CONNECTIVITY_OK"; readonly lastSuccessAt: number };

export function classifyConnectivity(evidence: ConnectivityEvidence): ConnectivityClassification {
  if (evidence.tunnelProcess === "STOPPED") return { state: "DISCONNECTED", reason: "CE_CONNECTIVITY_TUNNEL_STOPPED" };
  if (evidence.tunnelProcess === "UNKNOWN") return { state: "UNKNOWN", reason: "CE_CONNECTIVITY_TUNNEL_PROCESS_UNKNOWN" };
  if (evidence.tunnelHealth === "UNHEALTHY") return { state: "DISCONNECTED", reason: "CE_CONNECTIVITY_TUNNEL_UNHEALTHY" };
  if (evidence.tunnelHealth === "UNKNOWN") return { state: "UNKNOWN", reason: "CE_CONNECTIVITY_TUNNEL_HEALTH_UNKNOWN" };
  if (evidence.mcpProcess === "STOPPED") return { state: "DEGRADED", reason: "CE_CONNECTIVITY_MCP_STOPPED" };
  if (evidence.mcpProcess === "UNKNOWN") return { state: "UNKNOWN", reason: "CE_CONNECTIVITY_MCP_UNKNOWN" };
  if (evidence.sessionBinding === "detached") return { state: "DEGRADED", reason: "CE_CONNECTIVITY_SESSION_DETACHED" };
  if (evidence.sessionBinding === "unknown") return { state: "UNKNOWN", reason: "CE_CONNECTIVITY_SESSION_UNKNOWN" };
  return { state: "CONNECTED", reason: "CE_CONNECTIVITY_OK" };
}

export interface ConnectivityGuardOptions {
  readonly now?: () => number;
  readonly notify: (notice: ConnectivityNotice) => void;
}

export function createConnectivityGuard(options: ConnectivityGuardOptions) {
  const now = options.now ?? Date.now;
  let snapshot: ConnectivitySnapshot = { state: "UNKNOWN", reason: "CE_CONNECTIVITY_NOT_CHECKED", consecutiveFailures: 0 };
  let incidentNotified = false;
  let inFlight: Promise<ConnectivitySnapshot> | undefined;

  const observe = (evidence: ConnectivityEvidence): ConnectivitySnapshot => {
    const classification = classifyConnectivity(evidence);
    const checkedAt = now();
    if (classification.state === "CONNECTED") {
      const recovered = incidentNotified;
      snapshot = { ...classification, consecutiveFailures: 0, lastSuccessAt: checkedAt,
        ...(snapshot.lastFailureAt === undefined ? {} : { lastFailureAt: snapshot.lastFailureAt }),
        ...(snapshot.lastFailureReason === undefined ? {} : { lastFailureReason: snapshot.lastFailureReason }) };
      incidentNotified = false;
      if (recovered) options.notify({ kind: "recovery", state: "CONNECTED", reason: "CE_CONNECTIVITY_OK", lastSuccessAt: checkedAt });
      return snapshot;
    }
    if (classification.state === "UNKNOWN") {
      snapshot = { ...classification, consecutiveFailures: 0,
        ...(snapshot.lastSuccessAt === undefined ? {} : { lastSuccessAt: snapshot.lastSuccessAt }),
        ...(snapshot.lastFailureAt === undefined ? {} : { lastFailureAt: snapshot.lastFailureAt }),
        ...(snapshot.lastFailureReason === undefined ? {} : { lastFailureReason: snapshot.lastFailureReason }) };
      return snapshot;
    }
    const consecutiveFailures = snapshot.consecutiveFailures + 1;
    snapshot = { ...classification, consecutiveFailures, lastFailureAt: checkedAt, lastFailureReason: classification.reason,
      ...(snapshot.lastSuccessAt === undefined ? {} : { lastSuccessAt: snapshot.lastSuccessAt }) };
    if (consecutiveFailures >= 2 && !incidentNotified) {
      incidentNotified = true;
      options.notify({ kind: "failure", state: classification.state as "DEGRADED" | "DISCONNECTED", reason: classification.reason,
        ...(snapshot.lastSuccessAt === undefined ? {} : { lastSuccessAt: snapshot.lastSuccessAt }) });
    }
    return snapshot;
  };

  const check = (probe: () => Promise<ConnectivityEvidence>): Promise<ConnectivitySnapshot> => {
    if (inFlight !== undefined) return inFlight;
    const run = probe().then(observe, () => observe({ tunnelProcess: "UNKNOWN", tunnelHealth: "UNKNOWN", mcpProcess: "UNKNOWN", sessionBinding: "unknown" }));
    const shared = run.finally(() => { if (inFlight === shared) inFlight = undefined; });
    inFlight = shared;
    return shared;
  };

  return Object.freeze({ check, observe, snapshot: () => snapshot });
}
