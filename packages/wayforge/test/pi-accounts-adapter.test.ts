import { describe, expect, it, vi } from "vitest";
import {
  PiAccountsAdapter,
  type EventBusPort,
} from "../src/adapters/pi-accounts-adapter.js";

class TestEventBus implements EventBusPort {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
  }
}

function topologyReply(bus: TestEventBus, index = 0): (value: unknown) => void {
  const request = bus.emitted[index]?.data as { reply?: unknown } | undefined;
  expect(typeof request?.reply).toBe("function");
  return request!.reply as (value: unknown) => void;
}

function activationRequest(bus: TestEventBus, index = 0): {
  readonly session: object;
  readonly provider: string;
  readonly account: string | null;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly reply: (value: unknown) => void;
} {
  const request = bus.emitted[index]?.data;
  expect(request).toBeDefined();
  return request as {
    session: object;
    provider: string;
    account: string | null;
    model?: string;
    signal?: AbortSignal;
    reply: (value: unknown) => void;
  };
}

const validTopology = {
  providers: [
    {
      providerId: "anthropic",
      displayName: "Anthropic",
      accounts: [
        { name: "oauth-primary", kind: "oauth" },
        { name: "key-backup", kind: "api-key" },
      ],
      defaultAccount: "oauth-primary",
    },
  ],
};

describe("PiAccountsAdapter", () => {
  it("returns validated, sanitized topology through a fresh callback envelope", async () => {
    const bus = new TestEventBus();
    const adapter = new PiAccountsAdapter(bus, { timeoutMs: 100 });
    const pending = adapter.topology();

    expect(bus.emitted).toHaveLength(1);
    expect(bus.emitted[0]?.channel).toBe("accounts:topology:v1");
    topologyReply(bus)(validTopology);

    await expect(pending).resolves.toEqual({ status: "topology", topology: validTopology });
  });

  it("allows multiple providers, empty accounts, and no named default", async () => {
    const bus = new TestEventBus();
    const adapter = new PiAccountsAdapter(bus, { timeoutMs: 100 });
    const pending = adapter.topology();
    topologyReply(bus)({
      providers: [
        { providerId: "one", displayName: "One", accounts: [] },
        { providerId: "two", displayName: "Two", accounts: [{ name: "key", kind: "api-key" }] },
      ],
    });

    await expect(pending).resolves.toEqual({
      status: "topology",
      topology: {
        providers: [
          { providerId: "one", displayName: "One", accounts: [] },
          { providerId: "two", displayName: "Two", accounts: [{ name: "key", kind: "api-key" }] },
        ],
      },
    });
  });

  it.each([
    [{}, "missing providers"],
    [{ providers: {} }, "providers is not an array"],
    [{ providers: [{ displayName: "x", accounts: [] }] }, "providerId missing"],
    [{ providers: [{ providerId: "p", accounts: [] }] }, "displayName missing"],
    [{ providers: [{ providerId: "p", displayName: "P", accounts: {} }] }, "accounts not array"],
    [{ providers: [{ providerId: "p", displayName: "P", accounts: [{ kind: "oauth" }] }] }, "account name missing"],
    [{ providers: [{ providerId: "p", displayName: "P", accounts: [{ name: "a", kind: "cookie" }] }] }, "unknown kind"],
    [{ providers: [{ providerId: "p", displayName: "P", accounts: [], defaultAccount: 7 }] }, "invalid default"],
  ])("fails closed for malformed topology: %s", async (reply, _description) => {
    const bus = new TestEventBus();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).topology();
    topologyReply(bus)(reply);
    await expect(pending).resolves.toEqual({ status: "protocol_failure", code: "malformed_reply" });
  });

  it("first terminal reply wins and ignores duplicates", async () => {
    const bus = new TestEventBus();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).topology();
    const reply = topologyReply(bus);
    reply(validTopology);
    reply({ providers: [] });
    await expect(pending).resolves.toEqual({ status: "topology", topology: validTopology });
  });

  it("returns a bounded no-reply timeout and ignores its late callback", async () => {
    vi.useFakeTimers();
    try {
      const bus = new TestEventBus();
      const pending = new PiAccountsAdapter(bus, { timeoutMs: 50 }).topology();
      const reply = topologyReply(bus);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toEqual({ status: "protocol_failure", code: "timeout" });
      reply(validTopology);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards exact live session, named account, optional model, and signal", async () => {
    const bus = new TestEventBus();
    const session = {};
    const controller = new AbortController();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({
      session,
      provider: "anthropic",
      account: "oauth-primary",
      model: "claude",
      signal: controller.signal,
    });
    const request = activationRequest(bus);
    expect(bus.emitted[0]?.channel).toBe("accounts:activation:v1");
    expect(request).toMatchObject({ session, provider: "anthropic", account: "oauth-primary", model: "claude", signal: controller.signal });
    request.reply({ status: "active", providerId: "anthropic", accountName: "oauth-primary" });
    await expect(pending).resolves.toEqual({ status: "active", providerId: "anthropic", accountName: "oauth-primary" });
  });

  it("preserves null as Pi built-in authentication restoration, not named default selection", async () => {
    const bus = new TestEventBus();
    const session = {};
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({
      session,
      provider: "anthropic",
      account: null,
    });
    const request = activationRequest(bus);
    expect(request.account).toBeNull();
    expect(request).not.toHaveProperty("defaultAccount");
    request.reply({ status: "inactive", providerId: "anthropic", accountName: null });
    await expect(pending).resolves.toEqual({ status: "inactive", providerId: "anthropic", accountName: null });
  });

  it.each([
    "account_not_found",
    "authentication_failed",
    "store_unavailable",
    "effective_auth_conflict",
    "model_unavailable",
    "activation_superseded",
    "session_unavailable",
    "provider_unsupported",
    "cancelled",
    "activation_failed",
  ] as const)("preserves sanitized typed activation error %s", async (code) => {
    const bus = new TestEventBus();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({ session: {}, provider: "p", account: "a" });
    activationRequest(bus).reply({ status: "error", providerId: "p", accountName: "a", code });
    await expect(pending).resolves.toEqual({ status: "error", providerId: "p", accountName: "a", code });
  });

  it.each([
    [{ status: "unknown", providerId: "p", accountName: "a" }],
    [{ status: "active", providerId: "p", accountName: null }],
    [{ status: "inactive", providerId: "p", accountName: "a" }],
    [{ status: "error", providerId: "p", accountName: "a", code: "credential_leak" }],
    [{ status: "error", accountName: "a", code: "activation_failed" }],
  ])("fails closed for malformed activation reply", async (reply) => {
    const bus = new TestEventBus();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({ session: {}, provider: "p", account: "a" });
    activationRequest(bus).reply(reply);
    await expect(pending).resolves.toEqual({ status: "protocol_failure", code: "malformed_reply" });
  });

  it("does not emit activation when signal is already aborted", async () => {
    const bus = new TestEventBus();
    const controller = new AbortController();
    controller.abort();
    await expect(new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({
      session: {}, provider: "p", account: "a", signal: controller.signal,
    })).resolves.toEqual({ status: "protocol_failure", code: "cancelled" });
    expect(bus.emitted).toEqual([]);
  });

  it("settles cancellation while waiting and ignores late replies", async () => {
    const bus = new TestEventBus();
    const controller = new AbortController();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({
      session: {}, provider: "p", account: "a", signal: controller.signal,
    });
    const request = activationRequest(bus);
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "protocol_failure", code: "cancelled" });
    request.reply({ status: "active", providerId: "p", accountName: "a" });
  });

  it("times out activation without reclassifying it as authentication failure", async () => {
    vi.useFakeTimers();
    try {
      const bus = new TestEventBus();
      const pending = new PiAccountsAdapter(bus, { timeoutMs: 50 }).activate({ session: {}, provider: "p", account: "a" });
      const request = activationRequest(bus);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toEqual({ status: "protocol_failure", code: "timeout" });
      request.reply({ status: "error", providerId: "p", accountName: "a", code: "authentication_failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes no credential or raw-error fields in validated results", async () => {
    const bus = new TestEventBus();
    const pending = new PiAccountsAdapter(bus, { timeoutMs: 100 }).activate({ session: {}, provider: "p", account: "a" });
    activationRequest(bus).reply({
      status: "error", providerId: "p", accountName: "a", code: "activation_failed",
      accessToken: "secret", refreshToken: "secret", apiKey: "secret", authorization: "Bearer secret", cookies: "secret", body: "raw provider error",
    });
    const result = await pending;
    expect(result).toEqual({ status: "error", providerId: "p", accountName: "a", code: "activation_failed" });
    expect(JSON.stringify(result)).not.toMatch(/secret|Bearer|provider error/);
  });
});
