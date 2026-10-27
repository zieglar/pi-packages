/**
 * HANDOFF-853274 — MCP endpoint binding configuration validator tests.
 *
 * The validator is the trust boundary between operator-controlled launch
 * configuration and the MCP server's Endpoint identity: everything malformed,
 * ambiguous, oversized, or credential-shaped must be refused with a field
 * path only — never a configuration value.
 */
import { describe, expect, it } from "vitest";
import {
  MCP_BINDING_CONFIG_VERSION,
  McpBindingConfigError,
  parseMcpBindingConfig,
} from "../../src/host/mcp-binding-config.js";

const STORE_DIR = "/var/lib/chat-exchange";

function valid(): Record<string, unknown> {
  return {
    version: MCP_BINDING_CONFIG_VERSION,
    store: { directory: STORE_DIR },
    exchange: { namespace: "ce-mcp", idempotencyKey: "exchange-1" },
    endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [{ adapter: "pi", endpointId: "pi/main" }],
  };
}

function expectField(raw: unknown, field: string): void {
  try {
    parseMcpBindingConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(McpBindingConfigError);
    expect(error).toMatchObject({ code: "CE_MCP_CONFIG_INVALID", field });
    // The sanitized message carries the field path only.
    expect((error as McpBindingConfigError).message).toBe(`CE_MCP_CONFIG_INVALID at ${field}`);
    return;
  }
  throw new Error(`expected refusal at ${field}`);
}

describe("mcp binding config: acceptance", () => {
  it("accepts a minimal valid configuration and applies fixed defaults", () => {
    const config = parseMcpBindingConfig(valid());
    expect(config.store).toEqual({ directory: STORE_DIR, file: "ce-store.sqlite" });
    expect(config.lease).toEqual({ ttlSeconds: 120, renewIntervalSeconds: 30 });
    expect(config.payloadRead).toEqual({ enabled: false });
    expect(config.recipients).toEqual([{ adapter: "pi", endpointId: "pi/main" }]);
  });

  it("freezes the parsed configuration against later mutation", () => {
    const config = parseMcpBindingConfig(valid());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.recipients)).toBe(true);
    expect(Object.isFrozen(config.recipients[0])).toBe(true);
    expect(() => Object.assign(config.exchange, { namespace: "x" })).toThrow();
  });
});

describe("mcp binding config: structural refusals", () => {
  it("refuses a non-object root", () => {
    for (const raw of [null, [], 7, "config", true, () => {}]) expectField(raw, "config");
  });

  it("refuses prototype-carrying or accessor-backed objects", () => {
    class Carrier {
      get version() {
        return MCP_BINDING_CONFIG_VERSION;
      }
    }
    expectField(new Carrier(), "config");
    expectField({ ...valid(), get version() { return 1; } }, "config.version");
  });

  it("refuses an unknown or missing top-level field", () => {
    expectField({ ...valid(), extra: 1 }, "config");
    const missing = valid();
    delete (missing as Record<string, Record<string, unknown>>).store;
    expectField(missing, "config.store");
  });

  it("refuses a wrong or missing version", () => {
    expectField({ ...valid(), version: 2 }, "config.version");
    const missing = valid();
    delete (missing as Record<string, unknown>).version;
    expectField(missing, "config.version");
  });
});

describe("mcp binding config: store location", () => {
  it("refuses relative, unnormalized, or root directories", () => {
    for (const directory of ["relative/dir", "/var/../var/lib", "/var/lib/", "/", "", "a\0b"]) {
      expectField({ ...valid(), store: { directory } }, "store.directory");
    }
  });

  it("refuses unsafe or non-simple store file names but honors a valid custom one", () => {
    for (const file of ["../escape", "sub/dir.sqlite", ".hidden", "a b", ""]) {
      expectField({ ...valid(), store: { directory: STORE_DIR, file } }, "store.file");
    }
    const config = parseMcpBindingConfig({ ...valid(), store: { directory: STORE_DIR, file: "chat.sqlite" } });
    expect(config.store.file).toBe("chat.sqlite");
  });
});

describe("mcp binding config: labels and credentials", () => {
  it("refuses credential-shaped labels anywhere", () => {
    expectField({ ...valid(), endpoint: { adapter: "cap_0123456789abcdef", endpointId: "x" } }, "endpoint.adapter");
    expectField(
      { ...valid(), exchange: { namespace: "cap_0123456789abcdef0123", idempotencyKey: "k" } },
      "exchange.namespace",
    );
    expectField(
      { ...valid(), recipients: [{ adapter: "pi", endpointId: "cap_0123456789abcdef" }] },
      "recipients[0].endpointId",
    );
  });

  it("refuses empty, oversized, or non-string labels", () => {
    expectField({ ...valid(), endpoint: { adapter: "", endpointId: "chatgpt/main" } }, "endpoint.adapter");
    expectField({ ...valid(), endpoint: { adapter: "chatgpt", endpointId: 7 } }, "endpoint.endpointId");
    expectField({ ...valid(), exchange: { namespace: "x".repeat(257), idempotencyKey: "k" } }, "exchange.namespace");
  });
});

describe("mcp binding config: recipients", () => {
  it("refuses a non-array recipients list and malformed entries", () => {
    expectField({ ...valid(), recipients: "pi/main" }, "recipients");
    expectField({ ...valid(), recipients: [{ adapter: "pi" }] }, "recipients[0].endpointId");
    expectField({ ...valid(), recipients: [{ adapter: "pi", endpointId: "pi/main", note: "x" }] }, "recipients[0]");
  });

  it("refuses self-references and duplicates", () => {
    expectField(
      { ...valid(), recipients: [{ adapter: "pi", endpointId: "chatgpt/main" }] },
      "recipients[0]",
    );
    expectField(
      { ...valid(), recipients: [{ adapter: "pi", endpointId: "pi/main" }, { adapter: "mcp", endpointId: "pi/main" }] },
      "recipients[1]",
    );
  });

  it("accepts an empty recipients list", () => {
    expect(parseMcpBindingConfig({ ...valid(), recipients: [] }).recipients).toEqual([]);
  });
});

describe("mcp binding config: lease policy", () => {
  it("refuses out-of-range ttl and non-integer values", () => {
    for (const ttlSeconds of [0, 29, 3601, 12.5, "120", null]) {
      expectField({ ...valid(), lease: { ttlSeconds } }, "lease.ttlSeconds");
    }
  });

  it("refuses renewal intervals longer than half the term", () => {
    expectField({ ...valid(), lease: { ttlSeconds: 120, renewIntervalSeconds: 61 } }, "lease.renewIntervalSeconds");
    expectField({ ...valid(), lease: { ttlSeconds: 120, renewIntervalSeconds: 0 } }, "lease.renewIntervalSeconds");
    const accepted = parseMcpBindingConfig({ ...valid(), lease: { ttlSeconds: 120, renewIntervalSeconds: 60 } });
    expect(accepted.lease.renewIntervalSeconds).toBe(60);
  });

  it("derives a safe default renewal interval from a short term", () => {
    const config = parseMcpBindingConfig({ ...valid(), lease: { ttlSeconds: 40 } });
    expect(config.lease.renewIntervalSeconds).toBe(20);
  });

  it("refuses unknown lease and payloadRead fields", () => {
    expectField({ ...valid(), lease: { ttlSeconds: 120, grace: 5 } }, "lease");
    expectField({ ...valid(), payloadRead: { enabled: true, limit: 10 } }, "payloadRead");
    expectField({ ...valid(), payloadRead: { enabled: "true" } }, "payloadRead.enabled");
  });
});
