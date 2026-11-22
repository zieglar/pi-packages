import { randomUUID } from "node:crypto";

export type ProbeMode = "dry-run" | "pi-to-chatgpt" | "chatgpt-to-pi" | "both";
export type ProbeDirection = Exclude<ProbeMode, "dry-run" | "both">;
export type ProbeVerdict = "TRANSPORT_PASS" | "MCP_PASS" | "CLIENT_OBSERVED" | "WAKE_CONFIRMED" | "UNVERIFIED" | "FAIL";

export interface ProbeObservation {
  readonly direction: ProbeDirection;
  readonly sentAt?: string;
  readonly receivedAt?: string;
  readonly messageId?: string;
  readonly delivery?: "DELIVERED" | "ACKNOWLEDGED" | "DELIVERY_UNKNOWN" | "FAILED";
  readonly ackMessageId?: string;
  readonly replyMessageId?: string;
  readonly tunnelObserved?: boolean;
  readonly mcpObserved?: boolean;
  readonly clientObserved?: boolean;
  readonly wakeConfirmed?: boolean;
  readonly failureReason?: string;
}

export interface ProbeRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly mode: ProbeMode;
  readonly endpoint?: string;
  readonly sendAuthorized: boolean;
  readonly retryAuthorized: false;
  readonly observations: readonly ProbeObservation[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid probe evidence");
  return value as Record<string, unknown>;
}

export function parseProbeObservation(value: unknown): ProbeObservation {
  const item = record(value);
  if (item.direction !== "pi-to-chatgpt" && item.direction !== "chatgpt-to-pi") throw new Error("invalid probe observation");
  const strings = ["sentAt", "receivedAt", "messageId", "ackMessageId", "replyMessageId", "failureReason"];
  const booleans = ["tunnelObserved", "mcpObserved", "clientObserved", "wakeConfirmed"];
  if (strings.some((key) => item[key] !== undefined && typeof item[key] !== "string") ||
      booleans.some((key) => item[key] !== undefined && typeof item[key] !== "boolean") ||
      item.delivery !== undefined && !["DELIVERED", "ACKNOWLEDGED", "DELIVERY_UNKNOWN", "FAILED"].includes(item.delivery as string)) {
    throw new Error("invalid probe observation");
  }
  return { ...item } as unknown as ProbeObservation;
}

export function parseProbeRun(value: unknown): ProbeRun {
  const run = record(value);
  if (run.schemaVersion !== 1 || typeof run.runId !== "string" || typeof run.nonce !== "string" || typeof run.createdAt !== "string" ||
      !["dry-run", "pi-to-chatgpt", "chatgpt-to-pi", "both"].includes(run.mode as string) || typeof run.sendAuthorized !== "boolean" ||
      run.retryAuthorized !== false || !Array.isArray(run.observations)) throw new Error("invalid probe evidence");
  const observations = run.observations.map(parseProbeObservation);
  return { ...run, observations } as unknown as ProbeRun;
}

export function createProbeRun(input: { readonly mode?: ProbeMode; readonly endpoint?: string; readonly sendAuthorized?: boolean }): ProbeRun {
  const mode = input.mode ?? "dry-run";
  if (!["dry-run", "pi-to-chatgpt", "chatgpt-to-pi", "both"].includes(mode)) throw new Error("invalid probe mode");
  if (mode !== "dry-run" && !input.endpoint?.trim()) throw new Error("an explicit test endpoint is required");
  if (mode !== "dry-run" && input.sendAuthorized !== true) throw new Error("authorize a real send explicitly");
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
    mode,
    ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : {}),
    sendAuthorized: mode !== "dry-run" && input.sendAuthorized === true,
    retryAuthorized: false,
    observations: [],
  };
}

export function recordProbeObservation(run: ProbeRun, observation: ProbeObservation): ProbeRun {
  return { ...run, observations: [...run.observations, { ...observation }] };
}

function directionVerdict(observations: readonly ProbeObservation[]): ProbeVerdict {
  if (observations.some((item) => item.failureReason || item.delivery === "FAILED")) return "FAIL";
  const transport = observations.some((item) => item.messageId && (item.delivery === "DELIVERED" || item.delivery === "ACKNOWLEDGED"));
  if (!transport) return "UNVERIFIED";
  if (observations.some((item) => item.wakeConfirmed === true)) return "WAKE_CONFIRMED";
  if (observations.some((item) => item.clientObserved === true)) return "CLIENT_OBSERVED";
  if (observations.some((item) => item.mcpObserved === true)) return "MCP_PASS";
  if (transport) return "TRANSPORT_PASS";
  return "UNVERIFIED";
}

const rank: Record<ProbeVerdict, number> = { FAIL: -1, UNVERIFIED: 0, TRANSPORT_PASS: 1, MCP_PASS: 2, CLIENT_OBSERVED: 3, WAKE_CONFIRMED: 4 };

export function evaluateProbeRun(run: ProbeRun): ProbeVerdict {
  if (run.mode === "dry-run") return "UNVERIFIED";
  const directions: readonly ProbeDirection[] = run.mode === "both" ? ["pi-to-chatgpt", "chatgpt-to-pi"] : [run.mode];
  const verdicts = directions.map((direction) => directionVerdict(run.observations.filter((item) => item.direction === direction)));
  if (verdicts.includes("FAIL")) return "FAIL";
  return verdicts.reduce((lowest, verdict) => rank[verdict] < rank[lowest] ? verdict : lowest, "WAKE_CONFIRMED");
}
