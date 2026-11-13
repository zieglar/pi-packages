import fs from "node:fs";
import {join} from "node:path";
import {expect, it, vi} from "vitest";
import {fixture, cleanupFixtures} from "../../storage/support/participant-fixture.js";

/** Module evaluation seam, not real interactive reload acceptance. */
it("retains Runtime and observer identity across separate module evaluations", async () => {
  const f = fixture("identity-evaluation-");
  const allowlist = join(f.root, "empty-allowlist.json"); fs.writeFileSync(allowlist, "{}", {mode: 0o600});
  vi.stubEnv("CE_ALLOWLIST", allowlist); vi.stubEnv("CE_TUNNEL_PROFILE", "");
  vi.stubEnv("CE_STORE_DIR", f.directory); vi.stubEnv("CE_STORE_FILE", f.filename);
  const api = {on: () => {}, registerTool: () => {}, registerCommand: () => {}, appendEntry: () => {}};
  try {
    const first = await import("../../../pi-extension/index.js"); first.default(api as never);
    const key = Symbol.for("pi-chat-exchange.runtime-identity.v1");
    const globals = globalThis as typeof globalThis & { [key: symbol]: {runtimeId: string; observerId: string} };
    const state = globals[key]!;
    expect(state.runtimeId).toMatch(/^runtime-[a-f0-9-]{36}$/);expect(state.observerId).toMatch(/^[a-f0-9-]{36}$/);
    vi.resetModules();
    const second = await import("../../../pi-extension/index.js"); second.default(api as never);
    expect(second.default).not.toBe(first.default);expect(globals[key]).toBe(state);
  } finally { vi.unstubAllEnvs();cleanupFixtures(); }
});
