import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promiseHooks } from "node:v8";
import { afterEach, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { withImmediateTransaction } from "../../src/storage/transaction.js";

const roots: string[] = [];
function location() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "ce-r3-return-"));
  roots.push(directory);
  return { directory, filename: "store.sqlite" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["implicit", "explicit"])("F7: accepts only %s undefined return and commits", (kind) => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    const result = withImmediateTransaction(db, (tx) => {
      tx.prepare("INSERT INTO item VALUES (?)").run("one");
      if (kind === "explicit") return undefined;
    });
    expect(result).toBeUndefined();
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it.each([
  ["null", null], ["boolean", false], ["number", 0], ["NaN", NaN],
  ["string", "done"], ["bigint", 1n], ["symbol", Symbol("done")],
  ["object", {}], ["array", []], ["function", () => undefined],
] as const)("F7: rejects unsupported %s return and synchronously rolls back", (_name, value) => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    expect(() => withImmediateTransaction(db, (tx) => {
      tx.exec("INSERT INTO item VALUES ('one')");
      return value;
    })).toThrow(expect.objectContaining({ stage: "callback", outcome: "ROLLED_BACK", retryable: false }));
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
    withImmediateTransaction(db, (tx) => { tx.exec("INSERT INTO item VALUES ('reuse')"); });
  } finally { db.close(); }
});

it.each(["then getter", "rejecting thenable", "dynamic Proxy", "hostile Proxy", "hostile function Proxy", "revoked Proxy"])(
  "F7-B: rejects %s without inspecting properties or invoking thenable behavior", (kind) => {
    const db = openStorageConnection(location());
    let calls = 0;
    const trap = (): never => { calls++; throw new Error("must not execute user behavior"); };
    let value: object;
    if (kind === "then getter") value = Object.defineProperty({}, "then", { get: trap });
    else if (kind === "rejecting thenable") value = { then: (_resolve: unknown, reject: (error: Error) => void) => {
      calls++; reject(new Error("thenable rejection must not be invoked"));
    } };
    else if (kind === "dynamic Proxy") {
      value = new Proxy({}, { get: (_target, key) => { calls++; return key === "then" ? trap : undefined; } });
      // Required counterexample: property presence and Promise assimilation differ.
      expect("then" in value).toBe(false);
    } else if (kind === "hostile Proxy") {
      value = new Proxy({}, { get: trap, has: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
    } else if (kind === "hostile function Proxy") {
      value = new Proxy(() => undefined, { get: trap, has: trap, getPrototypeOf: trap });
    } else {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      value = revoked.proxy;
    }
    try {
      db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
      expect(() => withImmediateTransaction(db, (tx) => {
        tx.exec("INSERT INTO item VALUES ('one')");
        return value;
      })).toThrow(expect.objectContaining({ outcome: "ROLLED_BACK", retryable: false }));
      expect(calls).toBe(0);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  },
);

const nativeCases = [
  ["resolved", "return Promise.resolve('unsupported');"],
  ["rejected", "return Promise.reject(new Error('native rejection'));"],
  ["throwing constructor", `const p = Promise.reject(new Error('constructor rejection'));
    Object.defineProperty(p, 'constructor', { get() { propertyCalls++; throw new Error('constructor getter'); } }); return p;`],
  ["throwing species", `const p = Promise.reject(new Error('species rejection'));
    Object.defineProperty(p, 'constructor', { value: { get [Symbol.species]() { propertyCalls++; throw new Error('species getter'); } } }); return p;`],
  ["overridden then", `const p = Promise.reject(new Error('override rejection'));
    Object.defineProperty(p, 'then', { value() { propertyCalls++; throw new Error('overridden then'); } }); return p;`],
  ["native throwing then getter", `const p = Promise.reject(new Error('then rejection'));
    Object.defineProperty(p, 'then', { get() { propertyCalls++; throw new Error('then getter'); } }); return p;`],
  ["hostile subclass", `class Hostile extends Promise { static get [Symbol.species]() { propertyCalls++; throw new Error('subclass species'); } }
    return new Hostile((_resolve, reject) => reject(new Error('subclass rejection')));`],
  ["cross realm", "return runInNewContext(\"Promise.reject(new Error('realm rejection'))\");"],
  ["fulfilled payload later thenable", `const payload = {}; const p = Promise.resolve(payload);
    Object.defineProperty(payload, 'then', { value(_resolve, reject) { propertyCalls++; reject(new Error('must not assimilate payload')); } }); return p;`],
  ["fulfilled payload throwing then getter", `const payload = {}; const p = Promise.resolve(payload);
    Object.defineProperty(payload, 'then', { get() { propertyCalls++; throw new Error('must not read payload then'); } }); return p;`],
  ["frozen native", "return Object.freeze(Promise.reject(new Error('frozen rejection')));"],
  ["Proxy around native", `return new Proxy(Promise.reject(new Error('proxied rejection')), {
    get() { propertyCalls++; throw new Error('proxy getter'); }, has() { propertyCalls++; throw new Error('proxy has'); }
  });`],
  ["async continuation", `return (async () => {
    await Promise.resolve();
    try { tx.exec("INSERT INTO item VALUES ('after')"); } catch { handleDenied = true; }
    try { statement.run('retained'); } catch { statementDenied = true; }
    throw new Error('continuation rejection');
  })();`],
  ["pre-existing ordinary", "return existing;"],
  ["pre-existing configurable accessor", "return existing;"],
  ["pre-existing unmodifiable, creator-handled boundary", "return existing;"],
  ["pre-existing nonextensible, creator-handled boundary", "return existing;"],
  ["pre-existing data descriptor", "return existing;"],
] as const;

it.each(nativeCases)("F7-A: %s is rejected with zero writes and strict subprocess survival", (name, body) => {
  const options = location();
  const transactionUrl = new URL("../../src/storage/transaction.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    import { runInNewContext } from 'node:vm';
    import { isDeepStrictEqual } from 'node:util';
    import { withImmediateTransaction } from ${JSON.stringify(transactionUrl)};
    const db = new DatabaseSync(${JSON.stringify(join(options.directory, options.filename))});
    db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)');
    let propertyCalls = 0, unhandled = 0, handleDenied = false, statementDenied = false;
    let retained, statement, failure, existing;
    process.on('unhandledRejection', () => { unhandled++; });
    const name = ${JSON.stringify(name)};
    if (name.startsWith('pre-existing')) {
      existing = Promise.reject(new Error('pre-existing rejection'));
      if (name.includes('creator-handled')) {
        Promise.prototype.then.call(existing, undefined, () => undefined);
        if (name.includes('nonextensible')) Object.freeze(existing);
        else Object.defineProperty(existing, 'constructor', { get() { propertyCalls++; throw new Error('unmodifiable getter'); } });
      } else if (name.includes('configurable')) {
        Object.defineProperty(existing, 'constructor', { configurable: true, get() { propertyCalls++; throw new Error('configurable getter'); } });
      } else if (name.includes('data descriptor')) {
        Object.defineProperty(existing, 'constructor', { value: {}, configurable: true, writable: true, enumerable: true });
      }
    }
    const before = existing && Object.getOwnPropertyDescriptor(existing, 'constructor');
    try { withImmediateTransaction(db, tx => {
      retained = tx;
      statement = tx.prepare('INSERT INTO item VALUES (?)');
      statement.run('before');
      ${body}
    }); } catch (error) { failure = { outcome: error.outcome, retryable: error.retryable, stage: error.stage }; }
    const synchronous = { count: db.prepare('SELECT count(*) AS n FROM item').get().n, active: db.isTransaction };
    try { retained.exec("INSERT INTO item VALUES ('retained-handle')"); } catch { handleDenied = true; }
    try { statement.run('retained-statement'); } catch { statementDenied = true; }
    withImmediateTransaction(db, tx => {
      try { retained.exec("INSERT INTO item VALUES ('during-reuse')"); } catch { handleDenied = true; }
      try { statement.run('during-reuse'); } catch { statementDenied = true; }
    });
    await new Promise(resolve => setImmediate(resolve));
    const after = existing && Object.getOwnPropertyDescriptor(existing, 'constructor');
    const descriptorRestored = isDeepStrictEqual(before, after);
    console.log(JSON.stringify({ failure, synchronous, count: db.prepare('SELECT count(*) AS n FROM item').get().n,
      unhandled, propertyCalls, handleDenied, statementDenied, descriptorRestored }));
    db.close();
  `], { encoding: "utf8", timeout: 10_000 });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual({
    failure: { outcome: "ROLLED_BACK", retryable: false, stage: "callback" },
    synchronous: { count: 0, active: false }, count: 0,
    unhandled: 0, propertyCalls: 0, handleDenied: true, statementDenied: true, descriptorRestored: true,
  });
});

it.each(["commit", "throw", "unsupported"])("F7: initialization observer is removed after %s", (path) => {
  const db = openStorageConnection(location());
  try {
    const run = () => withImmediateTransaction(db, () => {
      if (path === "throw") throw new Error("callback failure");
      if (path === "unsupported") return {};
    });
    if (path === "commit") run(); else expect(run).toThrow();
    let initialized = 0;
    const stop = promiseHooks.onInit(() => { initialized++; });
    try {
      // A leaked observer would initialize an additional rejection-handler Promise.
      const value = new Promise<void>(() => undefined);
      expect(initialized).toBe(1);
      expect(Object.hasOwn(value, "constructor")).toBe(false);
    } finally { stop(); }
  } finally { db.close(); }
});
