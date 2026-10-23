/**
 * HANDOFF-CE-MULTI-SESSION-01 — Task 1 characterization ONLY (before any
 * production edit): the GENERATED LEGACY messaging configuration is
 * single-session, immutable, and reload-stable.
 *
 * These tests exercise the real publication/reload path
 * (`ensureManagedBinding` → `publishMessagingPair` → `readMessagingPair`)
 * against a temporary profile directory on the real filesystem. No real
 * Tunnel, credential, Store payload, or CE tool is touched: the store
 * directory named by the generated documents is never opened or initialized,
 * and all labels are synthetic.
 *
 * Characterized boundaries the multi-session plan (Task 2) builds on:
 * - One generation carries exactly ONE Pi runtime session → ONE endpoint; a
 *   second session is a separate immutable generation, never an in-place edit.
 * - Store / Exchange / chatgpt-main peer identity is shared across
 *   generations (identity-derived from the tunnel), so separate single-session
 *   generations already pin the shared Store + inbox peer.
 * - Reload is digest-bound: appending a second session to a published document
 *   breaks reload (legacy config can never be silently converted in place).
 * - CURRENT GAP: a binding listing BOTH Pi endpoints cannot publish a legacy
 *   messaging pair at all (publication requires exactly one recipient), so
 *   today no single generated config expresses A and B together.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiAllowlistDocument, publishMessagingPair, readMessagingPair, type PiSideConfigInput } from "../../dist/tunnel/messaging-config.js";
import { ensureManagedBinding } from "../../dist/tunnel/managed-binding.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const IDENTITY = {
  tunnelId: "tunnel_abcdefgh123456",
  organizationId: "org-old",
  adapter: "chatgpt",
} as const;

function profile(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-multi-pair-"));
  dirs.push(dir);
  return join(dir, "tunnel.yaml");
}

/** Managed binding for one Pi recipient of this tunnel identity. */
function bindingFor(profilePath: string, piEndpointId: string) {
  return ensureManagedBinding(profilePath, {
    ...IDENTITY,
    endpointId: "chatgpt/main",
    recipients: [{ adapter: "pi", endpointId: piEndpointId }],
    capabilities: { payloadRead: true, ack: true },
  });
}

function inputFor(config: ReturnType<typeof bindingFor>["config"], piEndpointId: string, piSessionId: string): PiSideConfigInput {
  return {
    chatgptEndpoint: config.endpoint,
    piEndpoint: { adapter: "pi", endpointId: piEndpointId },
    piSessionId,
    exchangeNamespace: config.exchange.namespace,
    exchangeIdempotencyKey: config.exchange.idempotencyKey,
    store: config.store,
    payloadRead: true,
    ack: true,
  };
}

describe("characterization: generated legacy generation is single-session and immutable", () => {
  it("builds exactly one session entry per generation and reloads it stably", () => {
    const profilePath = profile();
    const a = bindingFor(profilePath, "pi/A");
    const input = inputFor(a.config, "pi/A", "runtime-session-a");

    const document = buildPiAllowlistDocument(input);
    expect(Object.keys(document.sessions!)).toEqual(["runtime-session-a"]);
    expect((document.sessions as Record<string, unknown>)["runtime-session-a"]).toEqual({ endpointId: "pi/A" });
    expect(document.recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);

    const pair = publishMessagingPair(profilePath, a.config, input);
    const first = readMessagingPair(profilePath, pair.bindingPath);
    const second = readMessagingPair(profilePath, pair.bindingPath);
    expect(first).toBeDefined();
    // Reload re-parses from durable bytes: identical values, independent objects.
    expect(second!.config).toEqual(first!.config);
    expect(second!.config).not.toBe(first!.config);
    expect(second!.document).toEqual(first!.document);
    expect(Object.isFrozen(first!.config)).toBe(true);
    // A mutated in-memory reload result never leaks into the next reload.
    (first!.document.sessions as Record<string, unknown>)["runtime-session-b"] = { endpointId: "pi/B" };
    expect(Object.keys(readMessagingPair(profilePath, pair.bindingPath)!.document.sessions!)).toEqual(["runtime-session-a"]);
  });

  it("gives a second runtime session its own immutable generation with shared Store/Exchange/peer identity", () => {
    const profilePath = profile();
    const a = bindingFor(profilePath, "pi/A");
    const pairA = publishMessagingPair(profilePath, a.config, inputFor(a.config, "pi/A", "runtime-session-a"));
    const identityA = fs.lstatSync(pairA.bindingPath);
    const bytesA = fs.readFileSync(pairA.allowlistPath);

    // Same tunnel identity, different Pi recipient: a distinct managed binding
    // generation, never an edit of the in-use one.
    const b = bindingFor(profilePath, "pi/B");
    expect(b.path).not.toBe(a.path);
    expect(b.config.store).toEqual(a.config.store);
    expect(b.config.exchange).toEqual(a.config.exchange);
    expect(b.config.endpoint).toEqual(a.config.endpoint);

    const pairB = publishMessagingPair(profilePath, b.config, inputFor(b.config, "pi/B", "runtime-session-b"));
    expect(pairB.bindingPath).not.toBe(pairA.bindingPath);

    // Neither publication rewrote the other's generation (content-addressed,
    // link-only publication).
    expect(fs.lstatSync(pairA.bindingPath).ino).toBe(identityA.ino);
    expect(fs.readFileSync(pairA.allowlistPath)).toEqual(bytesA);

    const docA = readMessagingPair(profilePath, pairA.bindingPath)!.document;
    const docB = readMessagingPair(profilePath, pairB.bindingPath)!.document;
    // Each generation remains single-session and points at its own endpoint...
    expect(docA.sessions).toEqual({ "runtime-session-a": { endpointId: "pi/A" } });
    expect(docB.sessions).toEqual({ "runtime-session-b": { endpointId: "pi/B" } });
    // ...while pinning the SAME shared Store, Exchange, and chatgpt/main peer.
    expect(docA.store).toEqual(docB.store);
    expect(docA.exchangeNamespace).toEqual(docB.exchangeNamespace);
    expect(docA.exchangeIdempotencyKey).toEqual(docB.exchangeIdempotencyKey);
    expect(docA.recipients).toEqual(docB.recipients);
    // No Store file was ever created by publication (config identity only).
    expect(fs.existsSync(join(a.config.store.directory, a.config.store.file))).toBe(false);
  });

  it("refuses reload after a second session is appended in place (digest-bound single session)", () => {
    const profilePath = profile();
    const a = bindingFor(profilePath, "pi/A");
    const pair = publishMessagingPair(profilePath, a.config, inputFor(a.config, "pi/A", "runtime-session-a"));

    // In-place "conversion" of the legacy document: add session B to session
    // A's generation, preserving 0600 so only the digest can refuse it.
    const tampered = JSON.parse(fs.readFileSync(pair.allowlistPath, "utf8")) as Record<string, unknown>;
    (tampered.sessions as Record<string, unknown>)["runtime-session-b"] = { endpointId: "pi/B" };
    fs.writeFileSync(pair.allowlistPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });

    expect(() => readMessagingPair(profilePath, pair.bindingPath)).toThrow(
      expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID", field: "messaging.generation" }),
    );
  });

  it("CURRENT GAP: a binding listing both Pi endpoints cannot publish a legacy pair", () => {
    const profilePath = profile();
    // The managed binding itself can express both recipients...
    const both = ensureManagedBinding(profilePath, {
      ...IDENTITY,
      endpointId: "chatgpt/main",
      recipients: [
        { adapter: "pi", endpointId: "pi/A" },
        { adapter: "pi", endpointId: "pi/B" },
      ],
      capabilities: { payloadRead: true, ack: true },
    });
    expect(both.config.recipients).toHaveLength(2);

    // ...but the legacy publication requires exactly ONE recipient, so no
    // single generated config can carry sessions for A and B together today.
    // Recorded as the gap plan Task 2's explicit multi-registration closes.
    expect(() =>
      publishMessagingPair(profilePath, both.config, inputFor(both.config, "pi/A", "runtime-session-a")),
    ).toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID", field: "messaging.configuration" }));
  });
});
