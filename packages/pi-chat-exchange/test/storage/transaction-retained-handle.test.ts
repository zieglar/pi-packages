import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { withImmediateTransaction, type TransactionHandle } from "../../src/storage/transaction.js";

it("RH1: an earlier handle and statement remain revoked inside a later active transaction", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-b2-retained-"));
  const db = openStorageConnection({ directory: join(root, "db"), filename: "store.sqlite" });
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY)");
    let retained!: TransactionHandle;
    let statement!: ReturnType<TransactionHandle["prepare"]>;
    withImmediateTransaction(db, (tx) => {
      retained = tx;
      statement = tx.prepare("INSERT INTO item VALUES (?)");
      statement.run("first");
    });
    withImmediateTransaction(db, (tx) => {
      expect(db.isTransaction).toBe(true);
      expect(() => retained.exec("INSERT INTO item VALUES ('escaped-handle')")).toThrow(/revoked/);
      expect(() => retained.prepare("INSERT INTO item VALUES ('escaped-prepare')")).toThrow(/revoked/);
      expect(() => statement.run("escaped-statement")).toThrow(/revoked/);
      expect(() => statement.get("escaped-get")).toThrow(/revoked/);
      expect(() => statement.all("escaped-all")).toThrow(/revoked/);
      tx.prepare("INSERT INTO item VALUES (?)").run("second");
      expect(db.isTransaction).toBe(true);
    });
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT id FROM item ORDER BY id").all()).toEqual([{ id: "first" }, { id: "second" }]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
