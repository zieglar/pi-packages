/**
 * HANDOFF-CE-HOST-09 B1.1 Task 2 — scoped Keychain credential adapter.
 *
 * Dynamic module load keeps the first run a real assertion failure rather than
 * a module-resolution crash.
 *
 * Pinned contract (keychain-design-recon.md + B1.1 handoff):
 * - fixed service `pi-chat-exchange-tunnel`, versioned deterministic account
 *   derived from a validated canonical scope; B1.1 commands use an explicitly
 *   synthetic offline scope and never read an existing production profile.
 * - fixed operation allowlist; exact class/service/account; no prefix or
 *   service-wide fallback; no enumeration.
 * - native `errSecItemNotFound` (-25300) maps to CE_TUNNEL_KEY_MISSING; the
 *   `security(1)` CLI's exit 44 is NOT accepted as a native missing signal.
 * - no secret in argv/env/compiler arguments/files; raw stdout/stderr never
 *   escapes; closed codes only.
 * - no automatic retry after an ambiguous timeout.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SENTINEL = "sk-b11-keychain-canary-0002";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeychainModule = any;

const MODULE_SPECIFIER = "../../src/tunnel/keychain.js";

async function load(): Promise<KeychainModule | undefined> {
  try {
    return (await import(MODULE_SPECIFIER)) as KeychainModule;
  } catch {
    return undefined;
  }
}

async function mod(): Promise<KeychainModule> {
  const loaded = await load();
  expect(loaded, "src/tunnel/keychain.ts module namespace").toBeDefined();
  expect(typeof loaded.createKeychainCredentialStore, "createKeychainCredentialStore export").toBe("function");
  return loaded as KeychainModule;
}

interface Call {
  request: { op: string; service: string; account: string };
  secret: string | undefined;
}

function runner(responses: string[] | ((call: Call) => string | Promise<string>)): {
  run: ReturnType<typeof vi.fn>;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const run = vi.fn(async (request: Call["request"], secret?: string) => {
    calls.push({ request, secret });
    if (typeof responses === "function") return responses({ request, secret });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error("runner invoked more times than the test authorized");
    return next;
  });
  return { run, calls };
}

async function store(api: KeychainModule, responses: Parameters<typeof runner>[0], scope?: unknown) {
  const r = runner(responses);
  const credentialStore = api.createKeychainCredentialStore({
    runner: { run: r.run },
    scope: scope ?? api.OFFLINE_SYNTHETIC_SCOPE,
  });
  return { credentialStore, ...r };
}

describe("B1.1 keychain — scope and account derivation", () => {
  it("uses the fixed service and a versioned deterministic account", async () => {
    const api = await mod();
    expect(api.TUNNEL_KEYCHAIN_SERVICE).toBe("pi-chat-exchange-tunnel");
    const scope = { origin: "https://api.example.test", tunnelId: "tunnel_12345678" };
    const account = api.keychainAccountFor(scope);
    expect(account).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(api.keychainAccountFor({ ...scope })).toBe(account);
    expect(api.keychainAccountFor({ origin: scope.origin, tunnelId: "tunnel_87654321" })).not.toBe(account);
    // The two fields must be separated by an unambiguous NUL, so no pair of
    // distinct scopes can collide by shifting bytes across the boundary.
    const expected = createHash("sha256").update(`${scope.origin}\u0000${scope.tunnelId}`, "utf8").digest("hex");
    expect(account).toBe(`v1:${expected}`);
  });

  it("exposes an explicitly synthetic offline scope for B1.1 commands", async () => {
    const api = await mod();
    const scope = api.OFFLINE_SYNTHETIC_SCOPE;
    expect(scope.origin).toMatch(/invalid$/);
    expect(api.keychainAccountFor(scope)).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it.each([
    { origin: "http://api.example.test", tunnelId: "tunnel_12345678" },
    { origin: "https://operator:pw@api.example.test", tunnelId: "tunnel_12345678" },
    { origin: "https://api.example.test/path", tunnelId: "tunnel_12345678" },
    { origin: "https://api.example.test?x=1", tunnelId: "tunnel_12345678" },
    { origin: "https://api.example.test#f", tunnelId: "tunnel_12345678" },
    { origin: "https://api.example.test/", tunnelId: "tunnel_12345678" },
    { origin: "", tunnelId: "tunnel_12345678" },
    { origin: "https://api.example.test", tunnelId: "tunnel_short" },
    { origin: "https://api.example.test", tunnelId: "../../etc/passwd" },
    { origin: "https://api.example.test", tunnelId: "" },
  ])("refuses a non-canonical scope %#", async (scope) => {
    const api = await mod();
    expect(() => api.keychainAccountFor(scope)).toThrow(/CE_TUNNEL|rejected|invalid/i);
  });
});

describe("B1.1 keychain — CRUD protocol over the helper runner", () => {
  it("checks existence with the exact fixed query and without reading the value", async () => {
    const api = await mod();
    const s = await store(api, ['{"status":"ok"}']);
    expect(await s.credentialStore.exists()).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.request.op).toBe("exists");
    expect(s.calls[0]?.request.service).toBe("pi-chat-exchange-tunnel");
    expect(s.calls[0]?.request.account).toBe(api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE));
    expect(s.calls[0]?.secret).toBeUndefined();
  });

  it("reports absence without an error for exists()", async () => {
    const api = await mod();
    const s = await store(api, ['{"status":"not_found"}']);
    expect(await s.credentialStore.exists()).toBe(false);
  });

  it("creates when absent and updates when present, never guessing", async () => {
    const api = await mod();
    const absent = await store(api, ['{"status":"not_found"}', '{"status":"ok"}']);
    await absent.credentialStore.store(SENTINEL);
    expect(absent.calls.map((c) => c.request.op)).toEqual(["exists", "create"]);
    expect(absent.calls[1]?.secret).toBe(SENTINEL);

    const present = await store(api, ['{"status":"ok"}', '{"status":"ok"}']);
    await present.credentialStore.store(SENTINEL);
    expect(present.calls.map((c) => c.request.op)).toEqual(["exists", "update"]);
  });

  it("returns a read secret only to the caller and maps absence to KEY_MISSING", async () => {
    const api = await mod();
    // The helper frames the value as base64 so the response line stays ASCII.
    const encoded = Buffer.from(SENTINEL, "utf8").toString("base64");
    const ok = await store(api, [`{"status":"ok","secretBase64":"${encoded}"}`]);
    expect(await ok.credentialStore.read()).toBe(SENTINEL);

    // A raw (non-framed) `secret` field is not an accepted protocol shape.
    const unframed = await store(api, [`{"status":"ok","secret":${JSON.stringify(SENTINEL)}}`]);
    await expect(unframed.credentialStore.read()).rejects.toMatchObject({
      code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE",
    });

    const missing = await store(api, ['{"status":"not_found"}']);
    await expect(missing.credentialStore.read()).rejects.toMatchObject({ code: "CE_TUNNEL_KEY_MISSING" });
  });

  it("deletes the exact item and maps a missing item to KEY_MISSING", async () => {
    const api = await mod();
    const ok = await store(api, ['{"status":"ok"}']);
    await ok.credentialStore.remove();
    expect(ok.calls.map((c) => c.request.op)).toEqual(["delete"]);

    const missing = await store(api, ['{"status":"not_found"}']);
    await expect(missing.credentialStore.remove()).rejects.toMatchObject({ code: "CE_TUNNEL_KEY_MISSING" });
  });

  it("rejects a broad existing ACL instead of adopting or repairing it", async () => {
    const api = await mod();
    const s = await store(api, ['{"status":"error","reason":"acl_too_broad"}']);
    await expect(s.credentialStore.read()).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
  });
});

describe("B1.1 keychain — closed failure translation", () => {
  it.each([
    ["malformed json", "not json at all"],
    ["unknown status", '{"status":"weird"}'],
    ["missing status", "{}"],
    ["read without a secret", '{"status":"ok"}'],
    ["cli exit 44 masquerading as missing", '{"status":"error","exitCode":44}'],
    ["array response", "[]"],
  ])("maps %s to CE_TUNNEL_KEYCHAIN_UNAVAILABLE on read", async (_name, response) => {
    const api = await mod();
    const s = await store(api, [response]);
    await expect(s.credentialStore.read()).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
  });

  it("never forwards raw helper output or underlying error text", async () => {
    const api = await mod();
    const s = await store(api, [`{"status":"error","reason":"stderr: leaked ${SENTINEL}"}`]);
    const error = await s.credentialStore.read().catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(SENTINEL);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SENTINEL);
  });

  it("does not retry a mutation after an ambiguous timeout", async () => {
    const api = await mod();
    const s = await store(api, () => {
      throw new Error("helper timed out");
    });
    await expect(s.credentialStore.store(SENTINEL)).rejects.toMatchObject({
      code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE",
    });
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it("refuses to send a malformed secret to the helper at all", async () => {
    const api = await mod();
    for (const bad of ["", "has space", "line\nbreak", "é", "x".repeat(4097)]) {
      const s = await store(api, []);
      await expect(s.credentialStore.store(bad)).rejects.toMatchObject({ name: "TunnelRefusal" });
      expect(s.run).not.toHaveBeenCalled();
    }
  });
});

describe("B1.1 keychain — native helper runner hygiene", () => {
  it("validates the operation and account before spawning anything", async () => {
    const api = await mod();
    const spawnHelper = vi.fn();
    const compile = vi.fn();
    const native = api.createNativeKeychainRunner({ compile, spawnHelper });
    await expect(
      native.run({ op: "dump-all", service: api.TUNNEL_KEYCHAIN_SERVICE, account: "v1:" + "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    await expect(native.run({ op: "read", service: "other-service", account: "v1:" + "a".repeat(64) })).rejects
      .toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    await expect(native.run({ op: "read", service: api.TUNNEL_KEYCHAIN_SERVICE, account: "*" })).rejects
      .toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  it("passes the secret only through framed stdin, never argv or env", async () => {
    const api = await mod();
    const spawnHelper = vi.fn(async () => ({ stdout: '{"status":"ok"}\n', code: 0, timedOut: false }));
    const compile = vi.fn(async () => ({ executable: "/tmp/b11-fake/helper", dispose: async () => undefined }));
    const native = api.createNativeKeychainRunner({ compile, spawnHelper });
    const account = api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE);
    const response = await native.run({ op: "create", service: api.TUNNEL_KEYCHAIN_SERVICE, account }, SENTINEL);
    expect(response).toContain('"status":"ok"');

    const [executable, options] = spawnHelper.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(executable).toBe("/tmp/b11-fake/helper");
    expect(JSON.stringify(options.args ?? [])).not.toContain(SENTINEL);
    expect(JSON.stringify(options.env ?? {})).not.toContain(SENTINEL);
    for (const value of Object.values((options.env ?? {}) as Record<string, string>)) {
      expect(value).not.toContain(SENTINEL);
    }
    const stdin = String(options.stdin);
    expect(stdin.endsWith(SENTINEL)).toBe(true);
    expect(stdin.split("\n")[0]).toMatch(/^v1 create \d+ \d+$/);
    expect(JSON.stringify(compile.mock.calls)).not.toContain(SENTINEL);
  });

  it("compiles at most once and disposes the owned executable", async () => {
    const api = await mod();
    const dispose = vi.fn(async () => undefined);
    const compile = vi.fn(async () => ({ executable: "/tmp/b11-fake/helper", dispose }));
    const spawnHelper = vi.fn(async () => ({ stdout: '{"status":"ok"}', code: 0, timedOut: false }));
    const native = api.createNativeKeychainRunner({ compile, spawnHelper });
    const request = { op: "exists" as const, service: api.TUNNEL_KEYCHAIN_SERVICE, account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE) };
    await native.run(request);
    await native.run(request);
    expect(compile).toHaveBeenCalledTimes(1);
    await native.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await native.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["timeout", { stdout: "", code: null, timedOut: true }],
    ["non-zero exit", { stdout: '{"status":"ok"}', code: 3, timedOut: false }],
    ["oversized stdout", { stdout: "x".repeat(70_000), code: 0, timedOut: false }],
  ])("translates a %s into a closed refusal", async (_name, result) => {
    const api = await mod();
    const spawnHelper = vi.fn(async () => result);
    const compile = vi.fn(async () => ({ executable: "/tmp/b11-fake/helper", dispose: async () => undefined }));
    const native = api.createNativeKeychainRunner({ compile, spawnHelper });
    await expect(
      native.run({ op: "exists", service: api.TUNNEL_KEYCHAIN_SERVICE, account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE) }),
    ).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    expect(spawnHelper).toHaveBeenCalledTimes(1);
  });

  it("surfaces a compiler failure as a closed refusal without raw output", async () => {
    const api = await mod();
    const compile = vi.fn(async () => {
      throw new Error("swiftc: error: no such file or directory /nope");
    });
    const spawnHelper = vi.fn();
    const native = api.createNativeKeychainRunner({ compile, spawnHelper });
    const error = await native
      .run({ op: "exists", service: api.TUNNEL_KEYCHAIN_SERVICE, account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE) })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(String((error as Error).message)).not.toContain("swiftc");
    expect(spawnHelper).not.toHaveBeenCalled();
  });
});

describe("B1.1 keychain — native helper source invariants (static, NOT a compile or CRUD proof)", () => {
  // Read defensively so a missing helper source fails as an assertion rather
  // than crashing collection.
  function helperSource(): string {
    try {
      return readFileSync(fileURLToPath(new URL("../../native/tunnel-keychain.swift", import.meta.url)), "utf8");
    } catch {
      return "";
    }
  }
  const source = helperSource();

  it("links Security.framework APIs directly and resolves exactly one keychain", () => {
    expect(source.length, "native/tunnel-keychain.swift contents").toBeGreaterThan(0);
    expect(source).toContain("import Security");
    expect(source).toContain("SecKeychainCopyDefault");
    expect(source).toContain("SecKeychainFindGenericPassword");
  });

  it("creates an explicit EMPTY trusted-application list (never nil, never allow-all)", () => {
    expect(source.length, "native/tunnel-keychain.swift contents").toBeGreaterThan(0);
    expect(source).toContain("SecAccessCreate");
    expect(source).toMatch(/trustedApplications\s*:?\s*\[\]|emptyTrustedApps|\[\] as CFArray/);
    expect(source).not.toMatch(/SecAccessCreate\([^)]*,\s*nil\s*,/);
  });

  it("mutates and deletes only an exact resolved item reference", () => {
    expect(source.length, "native/tunnel-keychain.swift contents").toBeGreaterThan(0);
    expect(source).toContain("SecKeychainItemModifyAttributesAndData");
    expect(source).toContain("SecKeychainItemDelete");
    expect(source).not.toContain("SecItemDelete");
    expect(source).not.toContain("kSecMatchLimitAll");
  });

  it("distinguishes native errSecItemNotFound (-25300) from the CLI's exit 44", () => {
    expect(source.length, "native/tunnel-keychain.swift contents").toBeGreaterThan(0);
    expect(source).toContain("errSecItemNotFound");
    expect(source).toContain("not_found");
    expect(source).not.toMatch(/\b44\b/);
  });

  it("reads the secret from framed stdin and never from argv or the environment", () => {
    expect(source.length, "native/tunnel-keychain.swift contents").toBeGreaterThan(0);
    expect(source).not.toContain("CommandLine.arguments");
    expect(source).not.toContain("ProcessInfo.processInfo.environment");
    expect(source).toContain("readLine");
    expect(source).toContain("SecKeychainSetUserInteractionAllowed");
  });

  it("emits only fixed status tokens, never raw OSStatus text", () => {
    expect(source.length, "native/tunnel-keychain.swift contents").toBeGreaterThan(0);
    expect(source).not.toContain("SecCopyErrorMessageString");
    expect(source).not.toContain("localizedDescription");
    for (const token of ["\"status\":\"ok\"", "\"status\":\"not_found\"", "\"status\":\"error\""]) {
      expect(source).toContain(token);
    }
  });
});
