import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSqliteDriver } from "../../src/storage/sqlite-driver-selection.js";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { migrateStore } from "../../src/storage/migration.js";
import { issueCapability } from "../../src/storage/participant.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";
import {
  APPLICATION_ID,
  INITIAL_MIGRATION_CHECKSUM,
  INITIAL_MIGRATION_NAME,
  INITIAL_SCHEMA_SQL,
  SQLITE_APPLICATION_ID,
} from "../../src/storage/schema.js";
import { initializeStore, openStore } from "../../src/storage/store.js";
import { StorageTransactionError, withImmediateTransaction } from "../../src/storage/transaction.js";
import { hostSecretPath } from "../../src/storage/trust-root.js";

/**
 * CE-0002-B3-P1B hardening of the accepted P1A trust-root lifecycle. These are
 * the bounded coverage controls the independent P1A review identified as
 * missing; no accepted P1A design decision is reopened:
 *
 * A. interrupted `recoverTrustRoot`, including its fail-closed orphan state;
 * B. refusal when a v2 store has no durable trust-generation row;
 * C. entry-point BUSY propagation for `migrateStore` and `recoverTrustRoot`,
 *    plus the structural no-retry/no-repair control for INDETERMINATE;
 * E. trust-root refusals swept for secret material in cause chains and stacks.
 */

const roots: string[] = [];
const SECRET = new Uint8Array(32).fill(0x11);
const SECRET_HEX = Buffer.from(SECRET).toString("hex");
const REPLACEMENT = new Uint8Array(32).fill(0x22);
const REPLACEMENT_HEX = Buffer.from(REPLACEMENT).toString("hex");
const FINGERPRINT = createHash("sha256").update(SECRET_HEX, "utf8").digest("hex");
const REPLACEMENT_FINGERPRINT = createHash("sha256").update(REPLACEMENT_HEX, "utf8").digest("hex");
const NOW = "2026-10-10T00:00:00.000Z";
const LATER = "2026-10-10T01:00:00.000Z";

interface Location {
  readonly root: string;
  readonly directory: string;
  readonly filename: string;
  readonly databasePath: string;
}

function location(): Location {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-b3-hardening-"));
  roots.push(root);
  const directory = join(root, "database");
  return { root, directory, filename: "store.sqlite", databasePath: join(directory, "store.sqlite") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function v2Store(loc: Location): void {
  initializeStore({ ...loc, now: () => NOW, secretBytes: () => SECRET }).close();
}

/** Exactly the store an accepted v1 binary would have produced. */
function v1Store(loc: Location): void {
  const db = openStorageConnection(loc, undefined, true);
  try {
    withImmediateTransaction(db, (tx) => {
      tx.exec(INITIAL_SCHEMA_SQL);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, 1, ?)",
      ).run("018f5f43-52f8-7c5a-8f64-9d5e06d24a9a", APPLICATION_ID, NOW);
      tx.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (1, ?, ?, ?)").run(
        INITIAL_MIGRATION_NAME,
        INITIAL_MIGRATION_CHECKSUM,
        NOW,
      );
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      tx.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=1;`);
    });
  } finally {
    db.close();
  }
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

/** Sweeps an error, its whole cause chain, and its stack for secret material.
 * P1A deliberately keeps a filesystem `cause` on host-local artifact refusals
 * for operator diagnostics; what must never appear is secret or fingerprint
 * material. */
function assertNoSecretDisclosure(error: unknown, label: string): void {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    parts.push(current.name, current.message, String(current.stack ?? ""));
    if (current instanceof AggregateError) {
      for (const nested of current.errors) {
        if (nested instanceof Error) parts.push(nested.name, nested.message, String(nested.stack ?? ""));
      }
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  const corpus = parts.join(" ");
  for (const secret of [SECRET_HEX, REPLACEMENT_HEX]) {
    expect(corpus, `${label}: leaked secret material`).not.toContain(secret);
  }
  // The persisted fingerprints must not leak either.
  for (const digest of [FINGERPRINT, REPLACEMENT_FINGERPRINT]) {
    expect(corpus, `${label}: leaked fingerprint material`).not.toContain(digest);
  }
}

describe("P1A hardening A: interrupted trust-root recovery", () => {
  it("rolls back an interrupted recovery and fails closed on the orphan secret", () => {
    const loc = location();
    v2Store(loc);
    rmSync(hostSecretPath(loc.databasePath));

    const error = captureError(() =>
      recoverTrustRoot({
        ...loc,
        now: () => LATER,
        secretBytes: () => REPLACEMENT,
        beforeCommit: () => {
          throw new Error("simulated interruption");
        },
      }),
    );
    expect(error).toBeInstanceOf(StorageTransactionError);
    // The accepted classification propagates unchanged: a proven rollback is
    // ROLLED_BACK and is never silently retried or repaired.
    expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: false });
    assertNoSecretDisclosure(error, "interrupted recovery");

    // The durable state is unambiguous: generation 1 only, nothing revoked.
    const probe = new DatabaseSync(loc.databasePath, { readOnly: true, defensive: true });
    try {
      expect(probe.prepare("SELECT generation FROM host_trust_root ORDER BY generation").all()).toEqual([
        { generation: 1 },
      ]);
    } finally {
      probe.close();
    }

    // The new secret file survives as an orphan and blocks every retry until
    // the operator removes it: no silent overwrite, no automatic cleanup.
    expect(readFileSync(hostSecretPath(loc.databasePath), "utf8")).toBe(REPLACEMENT_HEX);
    expect(
      captureError(() => recoverTrustRoot({ ...loc, now: () => LATER, secretBytes: () => REPLACEMENT })),
    ).toMatchObject({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" });
    // The store itself still refuses to open: the orphan does not match the
    // persisted generation-1 fingerprint.
    expect(captureError(() => openStore(loc))).toMatchObject({ code: "STORAGE_TRUST_ROOT_MISMATCH" });

    // Explicit operator removal restores a recoverable state.
    rmSync(hostSecretPath(loc.databasePath));
    const recovered = recoverTrustRoot({ ...loc, now: () => LATER, secretBytes: () => REPLACEMENT });
    try {
      expect(recovered.database.prepare("SELECT generation FROM host_trust_root ORDER BY generation").all()).toEqual([
        { generation: 1 },
        { generation: 2 },
      ]);
    } finally {
      recovered.close();
    }
    expect(() => openStore(loc).close()).not.toThrow();
  });
});

describe("P1A hardening B: missing trust-generation row", () => {
  /** Removes the generation row while restoring the approved schema manifest
   * byte-for-byte, so the refusal under test is the missing row and not schema
   * drift. */
  function deleteGenerationRows(loc: Location): void {
    const db = openStorageConnection(loc);
    try {
      db.exec("DROP TRIGGER host_trust_root_nodelete");
      db.exec("DELETE FROM host_trust_root");
      db.exec(
        "CREATE TRIGGER host_trust_root_nodelete\nBEFORE DELETE ON host_trust_root BEGIN SELECT RAISE(ABORT, 'host trust root is append-only'); END;",
      );
    } finally {
      db.close();
    }
  }

  it("refuses to open a v2 store whose trust-generation row is missing", () => {
    const loc = location();
    v2Store(loc);
    deleteGenerationRows(loc);

    const error = captureError(() => openStore(loc));
    expect(error).toMatchObject({ code: "STORAGE_CORRUPT" });
    assertNoSecretDisclosure(error, "missing generation open");
    // Refusal over repair: no generation row is fabricated.
    const probe = new DatabaseSync(loc.databasePath, { readOnly: true, defensive: true });
    try {
      expect(probe.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM host_trust_root").get()).toEqual({ n: "0" });
    } finally {
      probe.close();
    }
  });

  it("refuses recovery and capability issuance when no generation row exists", () => {
    const loc = location();
    v2Store(loc);
    deleteGenerationRows(loc);

    // Recovery requires a current generation to succeed: an absent row is
    // corruption for operator review, not an implicit bootstrap.
    //
    // CE-0002-B3-P1B-R1 (MINOR-5): the typed STORAGE_CORRUPT refusal is raised
    // inside the owned transaction, and a proven non-retryable rollback now
    // keeps that refusal as the top-level classification. The transaction
    // outcome and its non-retryable classification remain available as the
    // preserved cause, with zero writes and no repair.
    rmSync(hostSecretPath(loc.databasePath));
    const recoveryError = captureError(() =>
      recoverTrustRoot({ ...loc, now: () => LATER, secretBytes: () => REPLACEMENT }),
    );
    expect(recoveryError).toMatchObject({ code: "STORAGE_CORRUPT" });
    const cause = (recoveryError as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(StorageTransactionError);
    expect(cause).toMatchObject({
      code: "STORAGE_TRANSACTION_FAILED",
      outcome: "ROLLED_BACK",
      retryable: false,
    });
    assertNoSecretDisclosure(recoveryError, "missing generation recovery");
    const probe = new DatabaseSync(loc.databasePath, { readOnly: true, defensive: true });
    try {
      expect(probe.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM host_trust_root").get()).toEqual({ n: "0" });
    } finally {
      probe.close();
    }
  });

  it("refuses capability issuance when the generation row disappears under an open store", () => {
    const loc = location();
    const store = initializeStore({ ...loc, now: () => NOW, secretBytes: () => SECRET });
    try {
      store.database
        .prepare("INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at, private_revision) VALUES (?, 'adapter-a', 'endpoint-1', ?, 1)")
        .run("prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", NOW);
      store.database.exec("DROP TRIGGER host_trust_root_nodelete");
      store.database.exec("DELETE FROM host_trust_root");

      const error = captureError(() =>
        issueCapability(
          store,
          { participantId: "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", scope: "join" },
          { now: () => NOW },
        ),
      );
      expect(error).toMatchObject({ code: "STORAGE_CORRUPT" });
      assertNoSecretDisclosure(error, "missing generation issuance");
      expect(store.database.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM participant_capability").get()).toEqual({
        n: "0",
      });
    } finally {
      store.close();
    }
  });
});

describe("P1A hardening C: entry-point transaction outcome propagation", () => {
  it("propagates BUSY from migrateStore without retry, repair, or orphan cleanup", () => {
    const loc = location();
    v1Store(loc);

    const holder = resolveSqliteDriver().open(loc.databasePath);
    holder.exec("BEGIN IMMEDIATE");
    let error: unknown;
    try {
      error = captureError(() =>
        migrateStore({ ...loc, fromVersion: 1, toVersion: 2, now: () => NOW, secretBytes: () => SECRET }),
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(error).toMatchObject({
      code: "STORAGE_TRANSACTION_BUSY",
      outcome: "ROLLED_BACK",
      retryable: true,
    });
    assertNoSecretDisclosure(error, "migration BUSY");

    // The store is still a valid v1 store and still answers migration-required.
    expect(captureError(() => openStore(loc))).toMatchObject({ code: "STORAGE_INCOMPATIBLE" });
    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(probe.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
    } finally {
      probe.close();
    }
    // The bootstrap secret from the failed attempt stays as a fail-closed
    // orphan until the operator removes it.
    expect(existsSync(hostSecretPath(loc.databasePath))).toBe(true);
    expect(
      captureError(() =>
        migrateStore({ ...loc, fromVersion: 1, toVersion: 2, now: () => NOW, secretBytes: () => SECRET }),
      ),
    ).toMatchObject({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" });
    // Explicit operator removal clears the orphan-secret ambiguity. Under the
    // current-only v7 contract a historical v1->v2 migration outcome is not a
    // PASS oracle, so only the security property is asserted: with the orphan
    // gone, the attempt is no longer refused as STORAGE_TRUST_ROOT_AMBIGUOUS.
    // Any returned handle is closed; success is deliberately not asserted.
    rmSync(hostSecretPath(loc.databasePath));
    expect(existsSync(hostSecretPath(loc.databasePath))).toBe(false);
    let afterRemoval: unknown;
    let returnedHandle: { close(): void } | undefined;
    try {
      returnedHandle = migrateStore({ ...loc, fromVersion: 1, toVersion: 2, now: () => NOW, secretBytes: () => SECRET });
    } catch (error) {
      afterRemoval = error;
    } finally {
      returnedHandle?.close();
    }
    expect((afterRemoval as { code?: unknown } | undefined)?.code).not.toBe("STORAGE_TRUST_ROOT_AMBIGUOUS");
    if (afterRemoval !== undefined) assertNoSecretDisclosure(afterRemoval, "migration after orphan removal");
  });

  it("propagates BUSY from recoverTrustRoot without retry or repair", () => {
    const loc = location();
    v2Store(loc);
    rmSync(hostSecretPath(loc.databasePath));

    const holder = resolveSqliteDriver().open(loc.databasePath);
    holder.exec("BEGIN IMMEDIATE");
    let error: unknown;
    try {
      error = captureError(() => recoverTrustRoot({ ...loc, now: () => LATER, secretBytes: () => REPLACEMENT }));
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(error).toMatchObject({
      code: "STORAGE_TRANSACTION_BUSY",
      outcome: "ROLLED_BACK",
      retryable: true,
    });
    assertNoSecretDisclosure(error, "recovery BUSY");

    const probe = new DatabaseSync(loc.databasePath, { readOnly: true, defensive: true });
    try {
      expect(probe.prepare("SELECT generation FROM host_trust_root").all()).toEqual([{ generation: 1 }]);
    } finally {
      probe.close();
    }
    // Orphan-first discipline again: retry refuses until explicit removal.
    expect(
      captureError(() => recoverTrustRoot({ ...loc, now: () => LATER, secretBytes: () => REPLACEMENT })),
    ).toMatchObject({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" });
    rmSync(hostSecretPath(loc.databasePath));
    recoverTrustRoot({ ...loc, now: () => LATER, secretBytes: () => REPLACEMENT }).close();
  });

  it("contains no retry, scheduling, or repair path in the migration and recovery entry points", () => {
    // INDETERMINATE cannot be injected at these entry points without handing
    // out the private writer connection, so the structural control proves what
    // the classification contract requires: the outcome is rethrown as-is,
    // with no retry loop, no scheduler, and no repair statement.
    for (const module of ["migration", "recovery", "participant", "capability"]) {
      const source = readFileSync(new URL(`../../src/storage/${module}.ts`, import.meta.url), "utf8");
      expect(source, `${module}: retry or scheduling path`).not.toMatch(
        /setTimeout|setInterval|process\.kill|SIGKILL|retryable\s*=\s*true|while\s*\(/,
      );
      expect(source, `${module}: repair path`).not.toMatch(/DROP\s+TRIGGER|PRAGMA\s+writable_schema|VACUUM/);
    }
    const migration = readFileSync(new URL("../../src/storage/migration.ts", import.meta.url), "utf8");
    const recovery = readFileSync(new URL("../../src/storage/recovery.ts", import.meta.url), "utf8");
    // Both entry points rethrow the accepted classification unchanged.
    expect(migration).toContain("throw error;");
    expect(recovery).toContain("throw error;");
  });
});

describe("P1A hardening E: trust-root refusal privacy", () => {
  it("discloses no secret or fingerprint material through cause chains or stacks", () => {
    const loc = location();
    v2Store(loc);
    const secretPath = hostSecretPath(loc.databasePath);

    // Missing artifact.
    rmSync(secretPath);
    assertNoSecretDisclosure(captureError(() => openStore(loc)), "missing secret");

    // Insecure artifact: the refusal keeps a filesystem cause for operator
    // diagnostics, and that cause chain must still carry no secret material.
    writeFileSync(secretPath, SECRET_HEX, { mode: 0o600 });
    chmodSync(secretPath, 0o644);
    const insecure = captureError(() => openStore(loc));
    expect(insecure).toMatchObject({ code: "STORAGE_TRUST_ROOT_INSECURE" });
    assertNoSecretDisclosure(insecure, "insecure secret");

    // Mismatched artifact.
    chmodSync(secretPath, 0o600);
    writeFileSync(secretPath, REPLACEMENT_HEX, { mode: 0o600 });
    const mismatch = captureError(() => openStore(loc));
    expect(mismatch).toMatchObject({ code: "STORAGE_TRUST_ROOT_MISMATCH" });
    assertNoSecretDisclosure(mismatch, "mismatched secret");

    // Ambiguous artifact during initialization keeps its filesystem cause.
    const fresh = location();
    mkdirSync(fresh.directory, { mode: 0o700 });
    writeFileSync(hostSecretPath(fresh.databasePath), SECRET_HEX, { mode: 0o600 });
    const ambiguous = captureError(() => initializeStore({ ...fresh, secretBytes: () => SECRET }));
    expect(ambiguous).toMatchObject({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" });
    assertNoSecretDisclosure(ambiguous, "ambiguous secret");
  });

  it("control: the trust-root sweep detects secrets in nested causes and stacks", () => {
    const nested = new Error("outer", { cause: new Error(`inner ${SECRET_HEX}`) });
    expect(() => assertNoSecretDisclosure(nested, "control")).toThrow();
    const aggregated = new Error("outer", {
      cause: new AggregateError([new Error(`aggregate ${REPLACEMENT_HEX}`)], "both failed"),
    });
    expect(() => assertNoSecretDisclosure(aggregated, "control")).toThrow();
    const stacked = new Error("outer");
    stacked.stack = `Error: outer\n    at leak (${SECRET_HEX}/file.ts:1:1)`;
    expect(() => assertNoSecretDisclosure(stacked, "control")).toThrow();
  });
});
