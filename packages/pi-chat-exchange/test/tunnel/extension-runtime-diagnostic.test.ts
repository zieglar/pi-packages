import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../dist/storage/store.js", async () => {
  const { RuntimeEligibilityError } = await import("../../dist/storage/runtime.js");
  const fail = () => { throw new RuntimeEligibilityError("private-underlying-detail"); };
  return { initializeStore: fail, openStore: fail };
});
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("reports runtime repair in session startup and ce-status without forwarding private causes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ce-host-runtime-diagnostic-")); roots.push(root);
  const allowlist = join(root, "allowlist.json");
  writeFileSync(allowlist, JSON.stringify({ exchangeNamespace: "runtime-test", exchangeIdempotencyKey: "runtime-1",
    recipients: [], sessions: { "pi-test": { endpointId: "pi-test" } } }));
  vi.stubEnv("CE_ALLOWLIST", allowlist); vi.stubEnv("CE_STORE_DIR", join(root, "UNOPENED-STORE"));
  const events = new Map<string, (...args: any[]) => Promise<void>>();
  const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
  const extensionUrl = new URL("../../pi-extension/index.ts", import.meta.url).href;
  const { default: factory } = await import(extensionUrl);
  factory({ on: (name: string, handler: never) => events.set(name, handler), registerTool: vi.fn(), appendEntry: vi.fn(),
    registerCommand: (name: string, command: never) => commands.set(name, command) } as never);
  const notify = vi.fn();
  const ctx = { hasUI: true, cwd: root, ui: { notify, setStatus: vi.fn() },
    sessionManager: { getSessionId: () => "pi-test", getBranch: () => [], getSessionFile: () => undefined } };
  await events.get("session_start")!({ reason: "startup" }, ctx);
  await commands.get("ce-status")!.handler("", ctx);
  const messages = notify.mock.calls.map(([message]) => String(message));
  expect(messages.filter((message) => message.includes("restart Pi"))).toHaveLength(2);
  expect(messages.join(" ")).toContain(process.version);
  expect(messages.join(" ")).not.toContain("private-underlying-detail");
});
