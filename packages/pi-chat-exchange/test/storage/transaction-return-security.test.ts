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
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "ce-r4-return-"));
  roots.push(directory);
  return { directory, filename: "store.sqlite" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const transactionUrl = new URL("../../src/storage/transaction.ts", import.meta.url).href;

/** Strict subprocesses prove process-level rejection behavior without crashing this suite. */
function strictSubprocess(body: string, options: { directory: string; filename: string }) {
  return spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    import { withImmediateTransaction } from ${JSON.stringify(transactionUrl)};
    const db = new DatabaseSync(${JSON.stringify(join(options.directory, options.filename))});
    db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)');
    let propertyCalls = 0, failure, retained, statement;
    ${body}
    db.close();
  `], { encoding: "utf8", timeout: 10_000 });
}

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
  ["null", null], ["false", false], ["true", true], ["number", 0], ["NaN", NaN],
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
      value = new Proxy({}, { get: trap, has: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, defineProperty: trap, deleteProperty: trap });
    } else if (kind === "hostile function Proxy") {
      value = new Proxy(() => undefined, { get: trap, has: trap, getPrototypeOf: trap, defineProperty: trap });
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

it("F7: an unsupported returned object is never mutated", () => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    const value = {};
    const before = Reflect.ownKeys(value);
    expect(() => withImmediateTransaction(db, () => value)).toThrow();
    expect(Reflect.ownKeys(value)).toEqual(before);
    expect(Object.isExtensible(value)).toBe(true);
  } finally { db.close(); }
});

it("F7: the helper installs no Promise initialization hook", () => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    let initialized = 0;
    const stop = promiseHooks.onInit(() => { initialized++; });
    try {
      // A returned native Promise is not observed: no reaction Promise is created.
      const created = Promise.resolve();
      const baseline = initialized;
      expect(() => withImmediateTransaction(db, (tx) => {
        tx.exec("INSERT INTO item VALUES ('one')");
        return created;
      })).toThrow(expect.objectContaining({ outcome: "ROLLED_BACK" }));
      expect(initialized).toBe(baseline);
      expect(Object.hasOwn(created, "constructor")).toBe(false);
      // A Promise created inside a committing callback is left entirely alone.
      let inner: Promise<void> | undefined;
      withImmediateTransaction(db, (tx) => {
        tx.exec("INSERT INTO item VALUES ('two')");
        inner = new Promise<void>(() => undefined);
      });
      expect(Object.hasOwn(inner!, "constructor")).toBe(false);
      expect(initialized).toBe(baseline + 1);
    } finally { stop(); }
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

/** `create` makes the Promise; the harness then attaches creator-owned rejection
 *  handling; `poison` only afterwards installs hostile accessors, so the sabotage
 *  observed by the helper is never triggered by the test's own handling. */
const creatorHandledCases = [
  ["resolved", "existing = Promise.resolve('unsupported');", ""],
  ["rejected", "existing = Promise.reject(new Error('native rejection'));", ""],
  ["throwing constructor getter", "existing = Promise.reject(new Error('constructor rejection'));",
    `Object.defineProperty(existing, 'constructor', { get() { propertyCalls++; throw new Error('constructor getter'); } });`],
  ["throwing species getter", "existing = Promise.reject(new Error('species rejection'));",
    `Object.defineProperty(existing, 'constructor', { value: { get [Symbol.species]() { propertyCalls++; throw new Error('species getter'); } } });`],
  ["overridden then", "existing = Promise.reject(new Error('override rejection'));",
    `Object.defineProperty(existing, 'then', { value() { propertyCalls++; throw new Error('overridden then'); } });`],
  ["throwing then getter", "existing = Promise.reject(new Error('then rejection'));",
    `Object.defineProperty(existing, 'then', { get() { propertyCalls++; throw new Error('then getter'); } });`],
  ["hostile subclass", `class Hostile extends Promise {
      static #armed = false;
      static arm() { Hostile.#armed = true; }
      static get [Symbol.species]() { if (Hostile.#armed) { propertyCalls++; throw new Error('subclass species'); } return Promise; }
    }
    existing = new Hostile((_resolve, reject) => reject(new Error('subclass rejection')));`,
    "existing.constructor.arm();"],
  ["cross realm", "existing = runInNewContext(\"Promise.reject(new Error('realm rejection'))\");", ""],
  ["frozen native", "existing = Promise.reject(new Error('frozen rejection'));", "Object.freeze(existing);"],
  ["fulfilled payload thenable", "const payload = {}; existing = Promise.resolve(payload);",
    `Object.defineProperty(payload, 'then', { get() { propertyCalls++; throw new Error('must not read payload then'); } });`],
  ["Proxy around native", `const inner = Promise.reject(new Error('proxied rejection'));
    Promise.prototype.then.call(inner, () => undefined, () => undefined);
    skipAttach = true;
    existing = new Proxy(inner, { get() { propertyCalls++; throw new Error('proxy getter'); }, has() { propertyCalls++; throw new Error('proxy has'); } });`,
    ""],
] as const;

it.each(creatorHandledCases)(
  "F7-A: creator-handled %s Promise return is rejected with zero writes and strict subprocess survival", (_name, create, poison) => {
    const options = location();
    const child = strictSubprocess(`
      import { runInNewContext } from 'node:vm';
      let existing, skipAttach = false;
      ${create}
      // The creator owns rejection handling; Chat Exchange never suppresses it.
      if (!skipAttach) Promise.prototype.then.call(existing, () => undefined, () => undefined);
      ${poison}
      const ownConstructorBefore = Object.hasOwn(existing, 'constructor');
      let unhandled = 0, handleDenied = false, statementDenied = false;
      process.on('unhandledRejection', () => { unhandled++; });
      try { withImmediateTransaction(db, tx => {
        retained = tx;
        statement = tx.prepare('INSERT INTO item VALUES (?)');
        statement.run('before');
        return existing;
      }); } catch (error) { failure = { outcome: error.outcome, retryable: error.retryable, stage: error.stage }; }
      const synchronous = { count: db.prepare('SELECT count(*) AS n FROM item').get().n, active: db.isTransaction };
      try { retained.exec("INSERT INTO item VALUES ('retained-handle')"); } catch { handleDenied = true; }
      try { statement.run('retained-statement'); } catch { statementDenied = true; }
      withImmediateTransaction(db, () => { db.exec("INSERT INTO item VALUES ('reuse')"); });
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({ failure, synchronous,
        count: db.prepare('SELECT count(*) AS n FROM item').get().n,
        unhandled, propertyCalls, handleDenied, statementDenied,
        mutated: Object.hasOwn(existing, 'constructor') !== ownConstructorBefore }));
    `, options);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({
      failure: { outcome: "ROLLED_BACK", retryable: false, stage: "callback" },
      synchronous: { count: 0, active: false },
      // Only the post-rollback reuse row is committed.
      count: 1,
      unhandled: 0, propertyCalls: 0, handleDenied: true, statementDenied: true, mutated: false,
    });
  },
);

it("F7: an async callback continuation cannot use the revoked handle and is creator-owned", () => {
  const options = location();
  const child = strictSubprocess(`
    let handleDenied = false, statementDenied = false, resumed = false;
    const continuation = (async () => {
      await Promise.resolve();
      resumed = true;
      try { retained.exec("INSERT INTO item VALUES ('after')"); } catch { handleDenied = true; }
      try { statement.run('retained'); } catch { statementDenied = true; }
      throw new Error('continuation rejection');
    });
    try { withImmediateTransaction(db, tx => {
      retained = tx;
      statement = tx.prepare('INSERT INTO item VALUES (?)');
      statement.run('before');
      const promise = continuation();
      // Creator-owned handling, declared by the callback author, not the helper.
      Promise.prototype.then.call(promise, undefined, () => undefined);
      return promise;
    }); } catch (error) { failure = { outcome: error.outcome, stage: error.stage }; }
    const synchronous = { count: db.prepare('SELECT count(*) AS n FROM item').get().n, resumed };
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled++; });
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ failure, synchronous, resumed, handleDenied, statementDenied, unhandled,
      count: db.prepare('SELECT count(*) AS n FROM item').get().n }));
  `, options);
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual({
    failure: { outcome: "ROLLED_BACK", stage: "callback" },
    // Rollback and revocation are synchronous, before the continuation resumes.
    synchronous: { count: 0, resumed: false },
    resumed: true, handleDenied: true, statementDenied: true, unhandled: 0, count: 0,
  });
});

it.each(["inside the callback", "outside the callback"])(
  "F7: an unrelated unhandled rejection created %s keeps unchanged process behavior", (placement) => {
    const options = location();
    const reject = "void Promise.reject(new Error('unrelated subsystem'));";
    const child = strictSubprocess(`
      ${placement === "inside the callback"
        ? `withImmediateTransaction(db, tx => { tx.exec("INSERT INTO item VALUES ('one')"); ${reject} });`
        : `withImmediateTransaction(db, tx => { tx.exec("INSERT INTO item VALUES ('one')"); });\n      ${reject}`}
      await new Promise(resolve => setImmediate(resolve));
      console.log('unexpectedly survived');
    `, options);
    // Identical in both placements: the helper never consumes a caller's rejection.
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("unrelated subsystem");
    expect(child.stdout).not.toContain("unexpectedly survived");
  },
);
