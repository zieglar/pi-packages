/**
 * CE-RR01 REWORK-01 (Lane C) — default-lane runtime spawn guard.
 *
 * The default `pnpm test` lane must never execute the locally installed
 * /opt/homebrew/bin/tunnel-client: that binary belongs only to the opt-in
 * `pnpm run test:installed-client` lane. This setup file activates ONLY when
 * CE_DEFAULT_CLIENT_GUARD === "1" (set by the `test` script) and then:
 *   - under vitest, registers a module mock for node:child_process so every
 *     spawn/spawnSync/execFile/execFileSync import in test files is wrapped;
 *   - additionally patches the CommonJS exports object, which also protects
 *     fresh child processes that call install() before their first
 *     node:child_process import (ESM named imports of builtins snapshot at
 *     first import per realm, so the patch must be in place first).
 * A wrapped call whose target basename is `tunnel-client` or whose path
 * contains /opt/homebrew/bin/tunnel-client throws BEFORE process creation;
 * every other target passes through to the real implementation untouched, so
 * synthetic fixtures keep spawning normally.
 */
import { createRequire } from "node:module";
import { basename } from "node:path";

const FORBIDDEN_PATH = "/opt/homebrew/bin/tunnel-client";
export const GUARD_MESSAGE =
  "CE default test lane isolation guard: refusing to spawn the installed tunnel-client; the default vitest lane must never execute /opt/homebrew/bin/tunnel-client — run the opt-in `pnpm run test:installed-client` lane instead";

/** The only child_process entry points that can create a process with an
 *  explicit target. `exec`/`execSync` shell strings are out of scope. */
const WRAPPED_FUNCTIONS = ["spawn", "spawnSync", "execFile", "execFileSync"] as const;

export function guardActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CE_DEFAULT_CLIENT_GUARD === "1";
}

export function forbiddenTarget(command: unknown): boolean {
  return typeof command === "string" && (command.includes(FORBIDDEN_PATH) || basename(command) === "tunnel-client");
}

type SpawnFunction = (command: string, ...rest: unknown[]) => unknown;
const GUARD_WRAPPED = "__ceDefaultClientGuardWrapped";

function wrapSpawnFunction(original: SpawnFunction): SpawnFunction {
  // Idempotent: never nest wrappers when install() runs again in the same realm.
  if (Object.prototype.hasOwnProperty.call(original, GUARD_WRAPPED)) return original;
  const wrapped: SpawnFunction = (command, ...rest) => {
    if (forbiddenTarget(command)) throw new Error(GUARD_MESSAGE);
    return original(command, ...rest);
  };
  Object.defineProperty(wrapped, GUARD_WRAPPED, { value: true });
  return wrapped;
}

/** Patch the CommonJS child_process exports. Requires the vitest module mock
 *  for ESM named imports; see the file header for the two-layer design. */
export function install(): void {
  const childProcess = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
  for (const name of WRAPPED_FUNCTIONS) {
    const original = childProcess[name];
    if (typeof original !== "function") continue;
    childProcess[name] = wrapSpawnFunction(original as SpawnFunction);
  }
}

if (guardActive()) {
  install();
  // Registered from a dynamic import so this file stays importable by plain
  // Node (the runtime probe) without a vitest dependency when inactive.
  const { vi } = await import("vitest");
  vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const mock = { ...actual } as Record<string, unknown>;
    for (const name of WRAPPED_FUNCTIONS) {
      const original = mock[name];
      if (typeof original !== "function") continue;
      mock[name] = wrapSpawnFunction(original as SpawnFunction);
    }
    // Default-import consumers must reach the wrapped functions too; the
    // spread would otherwise carry the untouched CommonJS default object.
    return Object.assign(mock, { default: mock });
  });
}
