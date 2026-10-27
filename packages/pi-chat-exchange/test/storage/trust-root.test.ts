import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";
import {
  APPLICATION_ID,
  SQLITE_APPLICATION_ID,
  V4_FOUNDATION_CHECKSUM,
  V4_FOUNDATION_NAME,
  V4_FOUNDATION_SQL,
} from "../../src/storage/schema.js";
import { initializeStore, openStore, preflightStoreShape } from "../../src/storage/store.js";
import { withImmediateTransaction } from "../../src/storage/transaction.js";
import { createHostSecretFile, hostSecretDigest, hostSecretPath } from "../../src/storage/trust-root.js";

const roots: string[] = [];
interface StoreLocation {
  readonly root: string;
  readonly directory: string;
  readonly filename: string;
}
function location(): StoreLocation {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-b3-trust-root-"));
  roots.push(root);
  return { root, directory: join(root, "database"), filename: "store.sqlite" };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const SECRET_A = new Uint8Array(32).fill(0x11);
const SECRET_B = new Uint8Array(32).fill(0x22);
const SECRET_A_HEX = Buffer.from(SECRET_A).toString("hex");
const SECRET_B_HEX = Buffer.from(SECRET_B).toString("hex");
const NOW_A = "2026-10-09T00:00:00.000Z";
const NOW_B = "2026-10-09T01:00:00.000Z";

function initialize(loc: StoreLocation): ReturnType<typeof initializeStore> {
  return initializeStore({ ...loc, now: () => NOW_A, secretBytes: () => SECRET_A });
}

function initializeV4Store(loc: StoreLocation): void {
  const databasePath = join(loc.directory, loc.filename);
  const db = openStorageConnection(loc, undefined, true);
  try {
    withImmediateTransaction(db, (tx) => {
      tx.exec(V4_FOUNDATION_SQL);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, 4, ?)",
      ).run("018f5f43-52f8-7c5a-8f64-9d5e06d24a9a", APPLICATION_ID, NOW_A);
      tx.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (4, ?, ?, ?)",
      ).run(V4_FOUNDATION_NAME, V4_FOUNDATION_CHECKSUM, NOW_A);
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      tx.prepare(
        "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
      ).run(hostSecretDigest(SECRET_A_HEX), NOW_A);
      tx.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=4;`);
    });
  } finally {
    db.close();
  }
  createHostSecretFile(databasePath, () => SECRET_A);
}

function secretFilePath(loc: StoreLocation): string {
  return hostSecretPath(join(loc.directory, loc.filename));
}

/** Byte-exact directory inventory, matching the refusal-test evidence style. */
function directorySnapshot(directory: string): [string, string][] {
  return readdirSync(directory)
    .sort()
    .map((name) => [name, readFileSync(join(directory, name)).toString("hex")]);
}

function captureError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return `${code} ${String(error)} ${error instanceof Error ? error.message : ""}`;
  }
  throw new Error("expected the operation to fail");
}

describe("host trust root (B3-P1A)", () => {
  it("fresh v2 initialization creates a 0600 host secret and a generation-1 fingerprint", () => {
    const loc = location();
    const store = initialize(loc);
    try {
      const secretPath = secretFilePath(loc);
      const stat = lstatSync(secretPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(Number(stat.mode) & 0o777).toBe(0o600);
      expect(readFileSync(secretPath, "utf8")).toBe(SECRET_A_HEX);
      expect(
        store.database.prepare("SELECT generation, secret_digest, created_at FROM host_trust_root").all(),
      ).toEqual([{ generation: 1, secret_digest: hostSecretDigest(SECRET_A_HEX), created_at: NOW_A }]);
    } finally {
      store.close();
    }
    // A valid reopen succeeds and performs zero trust-root writes.
    const reopened = openStore(loc);
    try {
      expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM host_trust_root").get()).toEqual({
        count: 1,
      });
    } finally {
      reopened.close();
    }
  });

  it("refuses a missing secret with STORAGE_TRUST_ROOT_MISSING and changes nothing", () => {
    const loc = location();
    initialize(loc).close();
    rmSync(secretFilePath(loc));
    const before = directorySnapshot(loc.directory);
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_MISSING" }),
    );
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });

  it("refuses a replaced secret with STORAGE_TRUST_ROOT_MISMATCH and never repairs it", () => {
    const loc = location();
    initialize(loc).close();
    const secretPath = secretFilePath(loc);
    writeFileSync(secretPath, SECRET_B_HEX);
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_MISMATCH" }),
    );
    // No regeneration and no repair: the replaced file is left exactly as found.
    expect(readFileSync(secretPath, "utf8")).toBe(SECRET_B_HEX);
  });

  it("refuses insecure secret artifacts: symlink, permissive mode, wrong length, bad encoding", () => {
    const symlinked = location();
    initialize(symlinked).close();
    const symlinkPath = secretFilePath(symlinked);
    const target = join(symlinked.root, "escaped-secret");
    writeFileSync(target, SECRET_A_HEX, { mode: 0o600 });
    rmSync(symlinkPath);
    symlinkSync(target, symlinkPath);
    expect(() => openStore(symlinked)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_INSECURE" }),
    );

    const permissive = location();
    initialize(permissive).close();
    chmodSync(secretFilePath(permissive), 0o644);
    expect(() => openStore(permissive)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_INSECURE" }),
    );

    const truncated = location();
    initialize(truncated).close();
    writeFileSync(secretFilePath(truncated), SECRET_A_HEX.slice(0, 10));
    expect(() => openStore(truncated)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_INSECURE" }),
    );

    const malformed = location();
    initialize(malformed).close();
    writeFileSync(secretFilePath(malformed), "z".repeat(64));
    expect(() => openStore(malformed)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_INSECURE" }),
    );
  });

  it("keeps trust generations append-only at the storage layer", () => {
    const store = initialize(location());
    try {
      expect(() =>
        store.database.prepare("UPDATE host_trust_root SET secret_digest = ? WHERE generation = 1").run(
          "0".repeat(64),
        ),
      ).toThrow(/append-only/);
      expect(() => store.database.exec("DELETE FROM host_trust_root")).toThrow(/append-only/);
      expect(() =>
        store.database
          .prepare("INSERT INTO host_trust_root(generation, secret_digest, created_at) VALUES (1, ?, ?)")
          .run("0".repeat(64), NOW_B),
      ).toThrow();
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM host_trust_root").get()).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  it("persists only the digest: the plaintext secret appears nowhere in SQLite", () => {
    const store = initialize(location());
    try {
      const dump = store.database
        .prepare(
          "SELECT group_concat(value, '|') AS dump FROM (" +
            "SELECT quote(rowid) AS value FROM store_metadata UNION ALL " +
            "SELECT quote(rowid) FROM schema_migrations UNION ALL " +
            "SELECT quote(rowid) FROM host_trust_root UNION ALL " +
            "SELECT quote(secret_digest) FROM host_trust_root UNION ALL " +
            "SELECT sql FROM sqlite_schema)",
        )
        .get() as { dump: string };
      expect(dump.dump).not.toContain(SECRET_A_HEX);
      expect(dump.dump).not.toContain(Buffer.from(SECRET_A).toString("base64"));
    } finally {
      store.close();
    }
  });

  it("operator recovery appends generation N+1 and revokes every existing capability", () => {
    const loc = location();
    const store = initialize(loc);
    store.database
      .prepare(
        "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", "pi", "endpoint-1", NOW_A);
    store.database
      .prepare(
        "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("a".repeat(64), "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", "join", 1, NOW_A);
    store.close();

    // The operator explicitly removes the lost secret first; recovery never
    // overwrites an existing file.
    rmSync(secretFilePath(loc));
    const recovered = recoverTrustRoot({ ...loc, now: () => NOW_B, secretBytes: () => SECRET_B });
    try {
      expect(
        recovered.database
          .prepare("SELECT generation, secret_digest, created_at FROM host_trust_root ORDER BY generation")
          .all(),
      ).toEqual([
        { generation: 1, secret_digest: hostSecretDigest(SECRET_A_HEX), created_at: NOW_A },
        { generation: 2, secret_digest: hostSecretDigest(SECRET_B_HEX), created_at: NOW_B },
      ]);
      expect(
        recovered.database.prepare("SELECT trust_generation, revoked_at FROM participant_capability").all(),
      ).toEqual([{ trust_generation: 1, revoked_at: NOW_B }]);
      expect(readFileSync(secretFilePath(loc), "utf8")).toBe(SECRET_B_HEX);
    } finally {
      recovered.close();
    }
    // The recovered store passes full normal-open validation under generation 2.
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("returns a validated v4 handle after recovery without misreporting the committed authority change", () => {
    const loc = location();
    initializeV4Store(loc);
    const writer = openStorageConnection(loc);
    try {
      writer.prepare(
        "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at) VALUES (?, ?, ?, ?)",
      ).run("prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", "pi", "endpoint-v4", NOW_A);
      writer.prepare(
        "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("b".repeat(64), "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", "join", 1, NOW_A);
    } finally {
      writer.close();
    }

    rmSync(secretFilePath(loc));
    const recovered = recoverTrustRoot({ ...loc, now: () => NOW_B, secretBytes: () => SECRET_B });
    try {
      expect(recovered.schemaVersion).toBe(4);
      expect(recovered.database.prepare("SELECT generation FROM host_trust_root ORDER BY generation").all())
        .toEqual([{ generation: 1 }, { generation: 2 }]);
      expect(recovered.database.prepare("SELECT revoked_at FROM participant_capability").all())
        .toEqual([{ revoked_at: NOW_B }]);
    } finally {
      recovered.close();
    }

    expect(preflightStoreShape(join(loc.directory, loc.filename)).kind).toBe("v4");
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
  });

  it("refuses recovery while any secret file exists (no silent overwrite, zero writes)", () => {
    const loc = location();
    initialize(loc).close();
    const before = directorySnapshot(loc.directory);
    expect(() => recoverTrustRoot({ ...loc, secretBytes: () => SECRET_B })).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" }),
    );
    expect(directorySnapshot(loc.directory)).toEqual(before);
    expect(readFileSync(secretFilePath(loc), "utf8")).toBe(SECRET_A_HEX);
  });

  it("refuses an orphan secret at initialization without creating any artifact", () => {
    const loc = location();
    mkdirSync(loc.directory, { mode: 0o700 });
    writeFileSync(secretFilePath(loc), SECRET_A_HEX, { mode: 0o600 });
    expect(() => initialize(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" }),
    );
    expect(existsSync(join(loc.directory, loc.filename))).toBe(false);
    // Explicit operator removal unblocks initialization.
    rmSync(secretFilePath(loc));
    expect(() => initialize(loc).close()).not.toThrow();
  });

  it("never exposes secret or fingerprint material through refusal errors", () => {
    const loc = location();
    initialize(loc).close();
    const digest = hostSecretDigest(SECRET_A_HEX);

    rmSync(secretFilePath(loc));
    const missing = captureError(() => openStore(loc));
    expect(missing).toContain("STORAGE_TRUST_ROOT_MISSING");
    expect(missing).not.toContain(SECRET_A_HEX);
    expect(missing).not.toContain(digest);

    writeFileSync(secretFilePath(loc), SECRET_B_HEX, { mode: 0o600 });
    const mismatch = captureError(() => openStore(loc));
    expect(mismatch).toContain("STORAGE_TRUST_ROOT_MISMATCH");
    expect(mismatch).not.toContain(SECRET_A_HEX);
    expect(mismatch).not.toContain(SECRET_B_HEX);
    expect(mismatch).not.toContain(digest);
  });
});
