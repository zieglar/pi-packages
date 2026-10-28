import { afterEach, describe, expect, it, vi } from "vitest";
import { readRuntimeIdentity, RuntimeEligibilityError } from "../../src/storage/runtime.js";

import { faultConnection } from "../support/sqlite-fault-connection.js";
import type { SqliteConnection } from "../../src/storage/sqlite-driver.js";
import { beforeEach } from "vitest";
let methods: ReturnType<typeof faultConnection>["methods"];
let fault: ReturnType<typeof faultConnection>["state"];
beforeEach(() => { ({ methods, state: fault } = faultConnection()); });
afterEach(() => { vi.restoreAllMocks(); });

describe("in-memory runtime API qualification fails closed", () => {
  it("refuses a missing defensive API", () => {
    vi.spyOn(methods, "enableDefensive").mockImplementation(() => { throw new TypeError("unavailable"); });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses a defensive API that leaves defensive mode disabled", () => {
    const enableDefensive = methods.enableDefensive;
    vi.spyOn(methods, "enableDefensive").mockImplementation(function (this: SqliteConnection) {
      enableDefensive.call(this, false);
    });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses an abnormal transaction state API", () => {
    fault.transactionState = true;
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses a missing authorizer API", () => {
    vi.spyOn(methods, "setAuthorizerPolicy").mockImplementation(() => { throw new TypeError("unavailable"); });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it.each(["all", "transaction-only", "savepoint-only"])("refuses ineffective %s authorizer denial", (kind) => {
    const original = methods.setAuthorizerPolicy;
    const exec = methods.exec;
    const prepare = methods.prepare;
    let denying = false;
    vi.spyOn(methods, "setAuthorizerPolicy").mockImplementation(function (this: SqliteConnection, policy) {
      denying = policy === "deny-transaction-control";
      return original.call(this, denying ? "off" : policy);
    });
    // Restore the unaffected denial through the real adapter policy; leave the
    // selected transaction or savepoint action ineffective at this boundary.
    vi.spyOn(methods, "exec").mockImplementation(function (this: SqliteConnection, sql) {
      if (denying && sql === "BEGIN" && kind === "savepoint-only") {
        original.call(this, "deny-transaction-control");
        try { return exec.call(this, sql); } finally { original.call(this, "off"); }
      }
      return exec.call(this, sql);
    });
    vi.spyOn(methods, "prepare").mockImplementation(function (this: SqliteConnection, sql) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("SAVEPOINT")) {
        const run = statement.run;
        statement.run = (...args) => {
          if (denying && kind === "transaction-only") {
            original.call(this, "deny-transaction-control");
            try { return run(...args); } finally { original.call(this, "off"); }
          }
          return run(...args);
        };
      }
      return statement;
    });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses unavailable statement APIs", () => {
    vi.spyOn(methods, "prepare").mockImplementation(() => { throw new TypeError("unavailable"); });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it.each(["commit", "strict", "json", "check", "foreign-key", "trigger"])("refuses ineffective %s behavior", (kind) => {
    const exec = methods.exec;
    const prepare = methods.prepare;
    vi.spyOn(methods, "exec").mockImplementation(function (this: SqliteConnection, sql) {
      if (kind === "commit" && sql === "COMMIT") return exec.call(this, "ROLLBACK");
      if (kind === "strict") sql = sql.replace(/\bSTRICT\b/g, "");
      if (kind === "check") exec.call(this, "PRAGMA ignore_check_constraints=ON");
      if (kind === "foreign-key" && sql === "PRAGMA foreign_keys=ON") sql = "PRAGMA foreign_keys=OFF";
      if (kind === "trigger" && sql.includes("CREATE TRIGGER runtime_probe_trigger")) sql = "CREATE TABLE runtime_probe_log (value INTEGER)";
      return exec.call(this, sql);
    });
    if (kind === "json") vi.spyOn(methods, "prepare").mockImplementation(function (this: SqliteConnection, sql) {
      return prepare.call(this, sql.includes("SELECT json_extract") ? "SELECT 0 AS extracted" : sql);
    });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses unrelated failures during authorizer checks", () => {
    const setAuthorizer = methods.setAuthorizerPolicy;
    const exec = methods.exec;
    let authorizing = false;
    vi.spyOn(methods, "setAuthorizerPolicy").mockImplementation(function (this: SqliteConnection, callback) {
      authorizing = callback !== "off";
      return setAuthorizer.call(this, callback);
    });
    vi.spyOn(methods, "exec").mockImplementation(function (this: SqliteConnection, sql) {
      if (authorizing && sql === "BEGIN") throw Object.assign(new Error("unrelated failure"), { errcode: 5 });
      return exec.call(this, sql);
    });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses an unrelated SQLite error instead of accepting it as constraint enforcement", () => {
    const prepare = methods.prepare;
    vi.spyOn(methods, "prepare").mockImplementation(function (this: SqliteConnection, sql) {
      if (sql.includes("INSERT INTO runtime_probe_strict")) throw Object.assign(new Error("unrelated failure"), { errcode: 5 });
      return prepare.call(this, sql);
    });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
});
