import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionPolicyError,
  DEFAULT_BUSY_TIMEOUT_MS,
  WAL_AUTOCHECKPOINT_PAGES,
  openStorageConnection,
} from "../../src/storage/connection.js";
import {
  APPROVED_NODE_VERSION,
  APPROVED_SQLITE_SOURCE_ID,
  APPROVED_SQLITE_VERSION,
  RuntimeEligibilityError,
  type RuntimeIdentity,
} from "../../src/storage/runtime.js";

const roots: string[] = [];

function storeLocation(): { directory: string; filename: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-chat-exchange-connection-"));
  roots.push(root);
  return { directory: join(root, "database"), filename: "store.sqlite" };
}

function pragma(db: ReturnType<typeof openStorageConnection>, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

const approvedIdentity: RuntimeIdentity = {
  nodeVersion: APPROVED_NODE_VERSION,
  sqliteVersion: APPROVED_SQLITE_VERSION,
  sqliteSourceId: APPROVED_SQLITE_SOURCE_ID,
  platform: process.platform,
  arch: process.arch,
  compileOptions: ["THREADSAFE=1", "MUTEX_PTHREADS"],
  sqliteCapabilities: ["defensive", "statement-get", "statement-all", "statement-run", "transaction-state"],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("private SQLite connection policy", () => {
  it("initializes and reads back every critical writer setting", () => {
    const db = openStorageConnection(storeLocation());
    try {
      expect(pragma(db, "journal_mode")).toBe("wal");
      expect(pragma(db, "synchronous")).toBe(2);
      expect(pragma(db, "foreign_keys")).toBe(1);
      expect(pragma(db, "trusted_schema")).toBe(0);
      expect(pragma(db, "busy_timeout")).toBe(DEFAULT_BUSY_TIMEOUT_MS);
      expect(pragma(db, "wal_autocheckpoint")).toBe(WAL_AUTOCHECKPOINT_PAGES);
      if (process.platform === "darwin") {
        expect(pragma(db, "fullfsync")).toBe(1);
        expect(pragma(db, "checkpoint_fullfsync")).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("enables SQLite defensive mode", () => {
    const db = openStorageConnection(storeLocation());
    try {
      db.exec("PRAGMA writable_schema=ON");
      expect(pragma(db, "writable_schema")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys and uniqueness", () => {
    const db = openStorageConnection(storeLocation());
    try {
      db.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id),
          UNIQUE(parent_id)
        );
      `);
      expect(() => db.prepare("INSERT INTO child VALUES (?, ?)").run("child-1", "missing")).toThrow();
      db.prepare("INSERT INTO parent VALUES (?)").run("parent-1");
      db.prepare("INSERT INTO child VALUES (?, ?)").run("child-1", "parent-1");
      expect(() => db.prepare("INSERT INTO child VALUES (?, ?)").run("child-2", "parent-1")).toThrow();
    } finally {
      db.close();
    }
  });

  it("reinitializes policy on every connection", () => {
    const location = storeLocation();
    const first = openStorageConnection(location);
    first.exec("PRAGMA foreign_keys=OFF");
    first.close();

    const second = openStorageConnection(location);
    try {
      expect(pragma(second, "foreign_keys")).toBe(1);
    } finally {
      second.close();
    }
  });

  it("checks runtime eligibility before every writable open", () => {
    const location = storeLocation();
    let checks = 0;
    const runtimeIdentity = (): RuntimeIdentity => {
      checks += 1;
      return approvedIdentity;
    };
    const first = openStorageConnection({ ...location, runtimeIdentity });
    first.close();
    const second = openStorageConnection({ ...location, runtimeIdentity });
    second.close();
    expect(checks).toBe(2);
  });

  it("rejects an unapproved engine before creating the database", () => {
    const location = storeLocation();
    expect(() =>
      openStorageConnection({
        ...location,
        runtimeIdentity: () => ({ ...approvedIdentity, sqliteVersion: "3.53.5" }),
      }),
    ).toThrow(RuntimeEligibilityError);
  });

  it.each([0, 5_001])("rejects an unbounded busy timeout of %dms", (busyTimeoutMs) => {
    expect(() => openStorageConnection({ ...storeLocation(), busyTimeoutMs })).toThrow(
      ConnectionPolicyError,
    );
  });
});
