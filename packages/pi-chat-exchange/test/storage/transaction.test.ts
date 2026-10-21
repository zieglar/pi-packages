import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import {
  ConditionalMutationError,
  StorageTransactionError,
  requireSingleRowChange,
  withImmediateTransaction,
} from "../../src/storage/transaction.js";

const roots: string[] = [];

function storeLocation(): { directory: string; filename: string; busyTimeoutMs: number } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-chat-exchange-transaction-"));
  roots.push(root);
  return { directory: join(root, "database"), filename: "store.sqlite", busyTimeoutMs: 25 };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("BEGIN IMMEDIATE transaction primitive", () => {
  it("commits a synchronous void callback", () => {
    const db = openStorageConnection(storeLocation());
    try {
      db.exec("CREATE TABLE item (id TEXT PRIMARY KEY)");
      const result = withImmediateTransaction(db, () => {
        expect(db.isTransaction).toBe(true);
        db.prepare("INSERT INTO item VALUES (?)").run("one");
      });
      expect(result).toBeUndefined();
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM item").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rolls back when the callback throws", () => {
    const db = openStorageConnection(storeLocation());
    try {
      db.exec("CREATE TABLE item (id TEXT PRIMARY KEY)");
      expect(() =>
        withImmediateTransaction(db, () => {
          db.prepare("INSERT INTO item VALUES (?)").run("one");
          throw new Error("stop");
        }),
      ).toThrow(StorageTransactionError);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM item").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects Promise-like callback results and rolls back", () => {
    const db = openStorageConnection(storeLocation());
    try {
      db.exec("CREATE TABLE item (id TEXT PRIMARY KEY)");
      expect(() =>
        withImmediateTransaction(db, () => {
          db.prepare("INSERT INTO item VALUES (?)").run("one");
          return Promise.resolve("not synchronous");
        }),
      ).toThrow(/synchronous/);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM item").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("inspects state and rolls back after a deferred foreign-key COMMIT failure", () => {
    const db = openStorageConnection(storeLocation());
    try {
      db.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
        );
      `);
      expect(() =>
        withImmediateTransaction(db, () => {
          db.prepare("INSERT INTO child VALUES (?, ?)").run("child", "missing");
        }),
      ).toThrow(StorageTransactionError);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM child").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("waits only for the configured bound when another writer holds the lock", () => {
    const location = storeLocation();
    const first = openStorageConnection(location);
    const second = openStorageConnection(location);
    try {
      expect(() =>
        withImmediateTransaction(first, () => {
          const started = performance.now();
          expect(() => withImmediateTransaction(second, () => undefined)).toThrow(
            StorageTransactionError,
          );
          expect(performance.now() - started).toBeLessThan(500);
        }),
      ).not.toThrow();
    } finally {
      second.close();
      first.close();
    }
  });

  it("rejects nested use on an already active connection", () => {
    const db = openStorageConnection(storeLocation());
    try {
      expect(() =>
        withImmediateTransaction(db, () => withImmediateTransaction(db, () => undefined)),
      ).toThrow(StorageTransactionError);
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("requires exactly one changed row for conditional mutations", () => {
    expect(() => requireSingleRowChange({ changes: 1 }, "claim update")).not.toThrow();
    expect(() => requireSingleRowChange({ changes: 0 }, "claim update")).toThrow(
      ConditionalMutationError,
    );
    expect(() => requireSingleRowChange({ changes: 2 }, "claim update")).toThrow(
      ConditionalMutationError,
    );
  });
});
