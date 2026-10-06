import { hostname, userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PING_PROTOCOL_VERSION,
  PingResultSchema,
  defaultHostLabel,
  ping,
} from "../../../src/control/mcp/ping.js";

const EXPECTED = {
  service: "pi-chat-exchange",
  protocolVersion: PING_PROTOCOL_VERSION,
  host: "test-host",
  status: "reachable",
} as const;

const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|AUTH|CRED|CERT|PRIVATE|SESSION|COOKIE)/i;

function sensitiveEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string);
}
describe("ping (smoke tool)", () => {
  it("is deterministic for a fixed host label", () => {
    expect(ping("test-host")).toEqual(EXPECTED);
    expect(ping("test-host")).toEqual(ping("test-host"));
  });

  it("validates against its own strict schema and nothing else", () => {
    expect(Value.Check(PingResultSchema, ping("test-host"))).toBe(true);
    expect(Value.Check(PingResultSchema, { ...EXPECTED, extra: "nope" })).toBe(false);
    expect(Value.Check(PingResultSchema, { ...EXPECTED, protocolVersion: 2 })).toBe(false);
    expect(Value.Check(PingResultSchema, { ...EXPECTED, status: "ok" })).toBe(false);
  });

  it("default host label leaks no machine identity or environment values", () => {
    const label = defaultHostLabel();
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toContain(hostname());
    expect(label).not.toContain(userInfo().username);

    const serialized = JSON.stringify(ping());
    for (const secret of sensitiveEnvValues()) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(process.cwd());
  });

  it("rejects unusable host labels", () => {
    expect(() => ping("")).toThrow();
    expect(() => ping("x".repeat(129))).toThrow();
  });
});
