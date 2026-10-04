import { describe, expect, it } from "vitest";
import { HealthRegistry } from "../src/recovery/health-registry.js";

describe("health registry", () => {
  it("records and looks up route, account, provider, and model health", () => {
    const registry = new HealthRegistry(() => 1_000);
    registry.recordRoute("route-a", { status: "available" });
    registry.recordAccount("acc-1", { status: "cooldown", cooldownMs: 500 });
    registry.recordProvider("anthropic", { status: "available" });
    registry.recordModel("claude-opus-4", { status: "available" });
    expect(registry.getRoute("route-a")?.status).toBe("available");
    expect(registry.getAccount("acc-1")?.status).toBe("cooldown");
    expect(registry.getProvider("anthropic")?.status).toBe("available");
    expect(registry.getModel("claude-opus-4")?.status).toBe("available");
  });

  it("owns cooldown centrally and reports unavailability during cooldown", () => {
    let now = 1_000;
    const registry = new HealthRegistry(() => now);
    registry.recordRoute("route-a", { status: "cooldown", cooldownMs: 10_000 });
    expect(registry.isAvailable("route-a")).toBe(false);
    now = 11_500;
    expect(registry.isAvailable("route-a")).toBe(true);
  });

  it("expires cooldowns deterministically from the injected clock", () => {
    let now = 0;
    const registry = new HealthRegistry(() => now);
    registry.recordRoute("route-b", { status: "cooldown", cooldownMs: 1_000, updatedAtMs: now });
    now = 999;
    expect(registry.isAvailable("route-b")).toBe(false);
    now = 1_000;
    expect(registry.isAvailable("route-b")).toBe(true);
  });

  it("treats unknown keys as available by default", () => {
    const registry = new HealthRegistry(() => 0);
    expect(registry.isAvailable("route-unknown")).toBe(true);
    expect(registry.getRoute("route-unknown")).toBeUndefined();
  });

  it("rejects secret-bearing metadata and raw provider bodies", () => {
    const registry = new HealthRegistry(() => 0);
    expect(() =>
      registry.recordRoute("route-a", { status: "available", metadata: { apiKey: "sk-1" } }),
    ).toThrow(/secret/i);
    expect(() =>
      registry.recordRoute("route-a", { status: "available", metadata: { response: "<html>" } }),
    ).toThrow(/secret|raw/i);
    expect(() =>
      registry.recordProvider("anthropic", { status: "available", metadata: { credential: "x" } }),
    ).toThrow(/secret/i);
  });

  it("keeps sanitized metadata in records", () => {
    const registry = new HealthRegistry(() => 0);
    registry.recordRoute("route-a", {
      status: "cooldown",
      cooldownMs: 100,
      metadata: { lastFailureKind: "rate_limit", attempts: 3 },
    });
    const record = registry.getRoute("route-a");
    expect(record?.metadata).toEqual({ lastFailureKind: "rate_limit", attempts: 3 });
  });

  it("never stores credentials or raw provider responses", () => {
    const registry = new HealthRegistry(() => 0);
    try {
      registry.recordModel("m", { status: "available", metadata: { apiKey: "sk-x", body: "raw" } });
    } catch {
      /* rejected */
    }
    const snapshot = JSON.stringify(registry.snapshot());
    expect(snapshot).not.toContain("sk-x");
    expect(snapshot).not.toContain("raw");
  });
});
