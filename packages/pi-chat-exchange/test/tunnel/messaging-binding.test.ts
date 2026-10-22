import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureManagedBinding } from "../../dist/tunnel/managed-binding.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function root(): string { const dir = fs.mkdtempSync(join(tmpdir(), "ce-messaging-binding-")); dirs.push(dir); return dir; }
const tunnelId = "tunnel_abcdefgh123456";
const organizationId = "org-AbC123XYZ789";
const chatgpt = { adapter: "chatgpt", endpointId: "chatgpt/main" } as const;
const pi = { adapter: "pi", endpointId: "pi/main" } as const;

describe("MESSAGING-INTEGRATION-01 — ChatGPT-side managed binding", () => {
  it("models the Tunnel MCP endpoint as the ChatGPT-side identity and authorizes only the selected Pi endpoint", () => {
    const dir = root();
    const result = ensureManagedBinding(join(dir, "tunnel.yaml"), {
      tunnelId, organizationId, adapter: chatgpt.adapter, endpointId: chatgpt.endpointId,
      recipients: [pi], capabilities: { payloadRead: true, ack: true },
    });
    const doc = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(doc.managed).toEqual({ tunnelId, organizationId, adapter: "chatgpt" }); // provenance keys unchanged; endpoint identity lives in `endpoint`
    expect(doc.endpoint).toEqual({ adapter: "chatgpt", endpointId: "chatgpt/main" });
    expect(doc.recipients).toEqual([pi]);
    expect(doc.payloadRead).toEqual({ enabled: true });
    expect(doc.ack).toEqual({ enabled: true });
    expect(doc.debugExecutionGuard).toEqual({ enabled: false });
    expect(doc.store).toEqual({ directory: join(dir, ".ce-bindings"), file: "ce-store.sqlite" });
    expect(doc.exchange.namespace).toBe(doc.exchange.idempotencyKey);
    expect(doc.exchange.namespace).not.toBe("pi-local");
    expect(doc.endpoint.endpointId).not.toBe("ce-b9f8aa869982f6c7");
  });

  it("defaults remain fail-closed and identity-derived (no endpointId = digest default)", () => {
    const dir = root();
    const result = ensureManagedBinding(join(dir, "tunnel.yaml"), { tunnelId, organizationId, adapter: "chatgpt" });
    const doc = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(doc.endpoint).toEqual({ adapter: "chatgpt", endpointId: doc.exchange.namespace });
    expect(doc.recipients).toEqual([]);
    expect(doc.payloadRead.enabled).toBe(false);
    expect(doc.ack.enabled).toBe(false);
  });

  it("the SAME identity with different capabilities produces a new digest generation and never mutates the in-use file", () => {
    const dir = root();
    const base = ensureManagedBinding(join(dir, "tunnel.yaml"), { tunnelId, organizationId, adapter: "chatgpt" });
    const baseText = fs.readFileSync(base.path, "utf8");
    const ready = ensureManagedBinding(join(dir, "tunnel.yaml"), {
      tunnelId, organizationId, adapter: "chatgpt", recipients: [pi], capabilities: { payloadRead: true, ack: true },
    });
    expect(ready.path).not.toBe(base.path);
    expect(fs.readFileSync(base.path, "utf8")).toBe(baseText);
    expect(fs.readdirSync(join(dir, ".ce-bindings")).filter((name) => name.startsWith("ce-"))).toHaveLength(2);
  });
});
