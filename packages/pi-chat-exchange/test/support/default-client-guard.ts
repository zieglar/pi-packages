/**
 * CE-RR01 REWORK-01 (Lane C) — default-lane runtime spawn guard.
 *
 * The default `pnpm test` lane must never execute the locally installed
 * /opt/homebrew/bin/tunnel-client: that binary belongs only to the opt-in
 * `pnpm run test:installed-client` lane. When CE_DEFAULT_CLIENT_GUARD === "1"
 * (set by the `test` script) this setup file calls install(), which patches
 * the CommonJS child_process exports — that also protects fresh child
 * processes that call install() before their first node:child_process import
 * (ESM named imports of builtins snapshot at first import per realm, so the
 * patch must be in place first). It additionally registers a vitest module
 * mock for node:child_process so every spawn/spawnSync/execFile/execFileSync
 * import in test files is wrapped.
 *
 * LANE ISOLATION (round 2): vitest 4.1.11 HOISTS the nested vi.mock below out
 * of any enclosing condition (it warns about exactly this), so the mock is
 * registered in EVERY vitest lane that loads this setup file — including lanes
 * without CE_DEFAULT_CLIENT_GUARD, such as `pnpm run test:installed-client`.
 * Isolation therefore CANNOT come from conditional registration: each wrapped
 * call consults process.env AT CALL TIME (guardActive() inside the wrapped
 * function, not at registration) and is a plain pass-through whenever
 * CE_DEFAULT_CLIENT_GUARD !== "1", so non-default lanes spawn exactly as if
 * the guard were absent. install() stays exported for direct tests of the
 * wrapper; its wrappers are env-respecting in exactly the same per-call way.
 *
 * The VITEST gate below only keeps plain-Node imports (the runtime probes)
 * away from the vitest mocker, which is uninitialized outside a test run; it
 * does not limit which lanes register, because vitest's hoisting ignores the
 * condition anyway.
 *
 * A wrapped call whose target basename is `tunnel-client` or whose path
 * contains /opt/homebrew/bin/tunnel-client throws BEFORE process creation
 * while active; every other target always passes through to the real
 * implementation untouched, so synthetic fixtures keep spawning normally.
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
  // The env is consulted AT CALL TIME, never at registration: registration
  // happens in every vitest lane (see the header's hoisting fact), so a lane
  // without CE_DEFAULT_CLIENT_GUARD must pass straight through to the real
  // spawn. This per-call check IS the lane-isolation mechanism.
  const wrapped: SpawnFunction = (command, ...rest) => {
    if (guardActive() && forbiddenTarget(command)) throw new Error(GUARD_MESSAGE);
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

if (guardActive()) install();

// Registered from a dynamic import so this file stays importable by plain
// Node (the runtime probes). vitest hoists this vi.mock out of the condition
// below and registers it in every lane regardless; the VITEST gate exists only
// so plain-Node imports never touch the uninitialized vitest mocker.
if (process.env.VITEST !== undefined) {
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
