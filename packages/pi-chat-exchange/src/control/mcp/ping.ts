/**
 * `ping` — the Phase 1 smoke tool (frozen v1 shape; service label follows the
 * project rename to pi-chat-exchange).
 *
 * Strictly read-only, deterministic, and free of credential or environment
 * leakage: the host label is derived only from the OS platform/release, never
 * from the hostname, username, home directory, or environment variables.
 */
import { platform, release } from "node:os";
import { Type, type Static } from "@sinclair/typebox";

export const PING_PROTOCOL_VERSION = 1 as const;
export const PING_TOOL_NAME = "ping" as const;
export const PING_SERVICE_NAME = "pi-chat-exchange" as const;

export const PingResultSchema = Type.Object(
  {
    service: Type.Literal(PING_SERVICE_NAME),
    protocolVersion: Type.Literal(PING_PROTOCOL_VERSION),
    host: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Literal("reachable"),
  },
  { additionalProperties: false },
);

export type PingResult = Static<typeof PingResultSchema>;

export const PingArgsSchema = Type.Object({}, { additionalProperties: false });

/**
 * Safe host label: OS platform + kernel release (e.g. "darwin 25.0.0").
 * Intentionally excludes hostname, username, home path, and all environment
 * values — nothing machine-identifying or credential-shaped is exposed.
 */
export function defaultHostLabel(): string {
  return `${platform()} ${release()}`;
}

export function ping(hostLabel: string = defaultHostLabel()): PingResult {
  if (hostLabel.length === 0) {
    throw new Error("host label must not be empty");
  }
  if (hostLabel.length > 128) {
    throw new Error("host label exceeds 128 characters");
  }
  return {
    service: PING_SERVICE_NAME,
    protocolVersion: PING_PROTOCOL_VERSION,
    host: hostLabel,
    status: "reachable",
  };
}
