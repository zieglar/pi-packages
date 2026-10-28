import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { withImmediateTransaction } from "../../src/storage/transaction.js";

const roots: string[] = [];
function location() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-r2-transaction-"));
  roots.push(root);
  return { directory: root, filename: "store.sqlite" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["COMMIT", "ROLLBACK", "END", "SAVEPOINT escape"])("F4: callback cannot execute %s through captured raw connection", (sql) => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    let failure: unknown;
    try {
      withImmediateTransaction(db, () => {
        db.exec("INSERT INTO item VALUES ('one')");
        db.exec(sql);
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ outcome: "ROLLED_BACK", retryable: false, stage: "callback" });
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
    expect(() => withImmediateTransaction(db, () => db.exec("INSERT INTO item VALUES ('two')"))).not.toThrow();
  } finally { db.close(); }
});

it("F4: preprepared COMMIT cannot bypass callback authorization", () => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    const commit = db.prepare("COMMIT");
    expect(() => withImmediateTransaction(db, () => {
      db.exec("INSERT INTO item VALUES ('one')");
      commit.run();
    })).toThrowError(expect.objectContaining({ outcome: "ROLLED_BACK", stage: "callback" }));
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

it("F4: unexpected inactive transaction is indeterminate and invalidates connection", () => {
  const db = openStorageConnection(location());
  db.exec("CREATE TABLE item(id TEXT PRIMARY KEY); INSERT INTO item VALUES ('one')");
  expect(() => withImmediateTransaction(db, () => {
    db.exec("INSERT OR ROLLBACK INTO item VALUES ('one')");
  })).toThrowError(expect.objectContaining({ outcome: "INDETERMINATE", retryable: false }));
  expect(() => withImmediateTransaction(db, () => undefined)).toThrow(/invalidated/);
  expect(() => db.prepare("SELECT 1")).toThrow();
});

it("F7: a rejected returned Promise rolls back and leaves rejection handling to its creator", () => {
  const options = location();
  const transactionUrl = new URL("../../src/storage/transaction.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    import { createNodeSqliteDriver } from ${JSON.stringify(new URL("../../src/storage/sqlite-driver-node.ts", import.meta.url).href)};
    import { withImmediateTransaction } from ${JSON.stringify(transactionUrl)};
    const db = createNodeSqliteDriver(createRequire(import.meta.url)("node:sqlite")).open(${JSON.stringify(join(options.directory, options.filename))});
    db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)');
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled++; });
    let rejected = false;
    try { withImmediateTransaction(db, () => {
      db.exec("INSERT INTO item VALUES ('one')");
      const promise = Promise.reject(new Error('async failure'));
      // The creator owns the Promise lifecycle, including its rejection.
      promise.catch(() => undefined);
      return promise;
    }); } catch { rejected = true; }
    const count = db.prepare('SELECT count(*) AS n FROM item').get().n;
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({unhandled, count, rejected, active: db.isTransaction}));
    db.close();
  `], { encoding: "utf8" });
  expect(JSON.parse(output.trim())).toEqual({ unhandled: 0, count: 0, rejected: true, active: false });
});

it("F4: deferred-FK commit failure is known rollback and allows reuse", () => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE p(id TEXT PRIMARY KEY); CREATE TABLE c(id TEXT PRIMARY KEY, p TEXT REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)");
    expect(() => withImmediateTransaction(db, () => db.exec("INSERT INTO c VALUES ('c', 'missing')")))
      .toThrowError(expect.objectContaining({ stage: "commit", outcome: "ROLLED_BACK", retryable: false }));
    expect(db.isTransaction).toBe(false);
    expect(() => withImmediateTransaction(db, () => db.exec("INSERT INTO p VALUES ('ok')"))).not.toThrow();
  } finally { db.close(); }
});

it("F4: failed rollback invalidates and closes the connection", () => {
  const db = openStorageConnection(location());
  // A privileged owner changing the authorizer is outside the callback capability
  // contract, but cleanup still must fail closed if that happens.
  expect(() => withImmediateTransaction(db, () => {
    db.setAuthorizer(() => 1); // SQLITE_DENY, including the helper's rollback
    throw new Error("cleanup probe");
  })).toThrowError(expect.objectContaining({ stage: "rollback", outcome: "INDETERMINATE", retryable: false }));
  expect(() => withImmediateTransaction(db, () => undefined)).toThrow(/invalidated/);
  expect(() => db.prepare("SELECT 1")).toThrow();
});

it("F7: async continuation cannot use a revoked handle or retained statement", async () => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    let resumed = false;
    let handleDenied = false;
    let statementDenied = false;
    let continuation: Promise<void> | undefined;
    expect(() => withImmediateTransaction(db, (tx) => {
      const statement = tx.prepare("INSERT INTO item VALUES (?)");
      statement.run("before");
      continuation = (async () => {
        await Promise.resolve();
        resumed = true;
        try { tx.exec("INSERT INTO item VALUES ('after')"); } catch { handleDenied = true; }
        try { statement.run("retained"); } catch { statementDenied = true; }
        throw new Error("continuation rejection is creator-owned");
      })();
      // The callback author owns the Promise it created, including rejection.
      continuation.catch(() => undefined);
      return continuation;
    })).toThrowError(expect.objectContaining({ outcome: "ROLLED_BACK" }));
    // Rollback and revocation happen synchronously, before the continuation.
    expect(resumed).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({ resumed, handleDenied, statementDenied }).toEqual({ resumed: true, handleDenied: true, statementDenied: true });
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
    expect(() => withImmediateTransaction(db, (tx) => { tx.prepare("INSERT INTO item VALUES (?)").run("reuse"); })).not.toThrow();
  } finally { db.close(); }
});

it.each(["COMMIT", "ROLLBACK"])("F4: scoped handle denies %s even if callback swallows denial", (sql) => {
  const db = openStorageConnection(location());
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    expect(() => withImmediateTransaction(db, (tx) => {
      tx.exec("INSERT INTO item VALUES ('one')");
      try { tx.exec(sql); } catch { /* helper must remember the denied attempt */ }
    })).toThrowError(expect.objectContaining({ outcome: "ROLLED_BACK" }));
    expect(db.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

it("F4: privileged unexpected commit is reported indeterminate, never retryable", () => {
  const options = location();
  const db = openStorageConnection(options);
  db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
  expect(() => withImmediateTransaction(db, (tx) => {
    tx.exec("INSERT INTO item VALUES ('durable')");
    // Deliberately violate the private raw-owner contract; verify detection.
    db.setAuthorizer(null);
    db.exec("COMMIT");
  })).toThrowError(expect.objectContaining({ outcome: "INDETERMINATE", retryable: false }));
  expect(() => withImmediateTransaction(db, () => undefined)).toThrow(/invalidated/);
  const reader = openStorageConnection(options);
  try { expect(reader.prepare("SELECT count(*) AS n FROM item").get()).toEqual({ n: 1 }); } finally { reader.close(); }
});

it("F4: independent-process writer contention remains bounded and retryable only after known no-write outcome", async () => {
  const options = location();
  const db = openStorageConnection({ ...options, busyTimeoutMs: 25 });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(join(options.directory, options.filename))});
    db.exec('BEGIN IMMEDIATE');
    console.log('ready');
    process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`writer exited before ready: ${code}`)));
      child.stdout.once("data", (data: Buffer) => data.toString().includes("ready") ? resolve() : reject(new Error("unexpected child output")));
    });
    const started = performance.now();
    expect(() => withImmediateTransaction(db, () => undefined)).toThrowError(expect.objectContaining({
      stage: "begin", outcome: "ROLLED_BACK", retryable: true, code: "STORAGE_TRANSACTION_BUSY",
    }));
    expect(performance.now() - started).toBeLessThan(500);
  } finally {
    child.stdin.end("release");
    expect(await exited).toBe(0);
    db.close();
  }
});

it("F4: unreadable transaction state cannot escape outcome classification", () => {
  const db = openStorageConnection(location());
  expect(() => withImmediateTransaction(db, () => { db.close(); }))
    .toThrowError(expect.objectContaining({ outcome: "INDETERMINATE", retryable: false }));
  expect(() => withImmediateTransaction(db, () => undefined)).toThrow(/invalidated/);
});
