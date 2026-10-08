# Private storage security boundaries (CE-0002-B1-R2)

This is a private SQLite foundation, not a delivery/dispatch implementation.
The public protocol and lifecycle vocabulary are unchanged.

## Immutability and compatibility

Every writer enables and reads back `recursive_triggers=ON`. This causes
conflicting `INSERT OR REPLACE` deletions to run the existing immutable-row
triggers for Result, audit, migration ledger, and store identity metadata.
File-backed tests exercise primary and secondary unique-key collisions as
well as UPDATE and DELETE. Raw connection owners must not disable policy.

Reopen compares the complete ordered `sqlite_schema` manifest (`type`, `name`,
`tbl_name`, `sql`, including implicit indexes) with an isolated reference built
from the approved migration SQL. Root-page layout is excluded. SQL is not
whitespace-normalized: even equivalent unauthorized DDL is incompatible.
Columns, STRICT/CHECK/FK/UNIQUE constraints, triggers, indexes, extra tables and
views are covered. Version and migration-ledger checks remain independent.
Drift is refused, never repaired or migrated.

## Filesystem and refusal

All directory components must be real directories, with no ancestor symlinks.
Use canonical OS paths (for example canonicalize a temporary root before
creating the private directory; macOS `/var` and `/tmp` aliases are symlinks).
The final directory remains current-user-owned and 0700, on an approved local
filesystem. DB/WAL/SHM artifacts are checked with `lstat`, including dangling
links, and must be owned regular 0600 files. New database files use exclusive
creation and `O_NOFOLLOW`. Initialization cannot overwrite a racing existing
name. These checks happen before SQLite opens the path.

An existing store receives a nonmutating **read-only snapshot preflight**.
Opening the original with SQLite `readOnly` is insufficient: WAL shared-memory
artifacts can still be changed. A private disposable directory holds copies of
DB and, if present, WAL; SQLite opens only that copy read-only. The copied WAL
is read rather than ignored; SHM is reconstructed in the disposable directory.
A rollback journal causes refusal rather than implicit recovery. Snapshot
artifacts are removed on normal success/failure. Tests compare exact original
DB/WAL/SHM bytes and directory inventories on rejected stores, including a
live WAL writer. No journal-mode change is made to refused DELETE stores.

After successful preflight, the selected original's identity, restore hold,
version, ledger, live schema, and integrity are revalidated in a read transaction
before persistent writer policy, then revalidated before returning the handle.
UUID changes or a disappeared source are refused.

**Limitations:** DB/WAL copying is not an atomic backup. Concurrent modification
can cause conservative refusal. Ancestor/artifact checks, copying, SQLite's
pathname open, and writer setup have TOCTOU windows; writer revalidation reduces
but does not eliminate races. Node's SQLite binding does not accept the
preopened no-follow descriptor. Trusted parent directories and an operator
controlling the store namespace are required. An attacker with equivalent
filesystem authority can replace paths or database contents; no complete
protection against that actor, mount replacement, or power-loss durability is
claimed. Snapshot I/O and startup scan budgets remain deferred (F8).

## Transaction ownership and outcomes

`withImmediateTransaction` remains synchronous. Callbacks receive a frozen,
revocable handle exposing only `exec` and `prepare`, whose frozen statements
expose only synchronous `run`, `get`, and `all`. No raw connection, authorizer,
transaction controls, or iterator is returned by that handle. SQLite's native
authorizer denies parsed transaction/savepoint actions during the callback,
including captured or preprepared raw-connection COMMIT/ROLLBACK statements.
A swallowed denial still makes the operation fail and roll back.

Normal return means **COMMITTED**. Transaction errors carry `outcome` and
`retryable`: **ROLLED_BACK** requires a known no-write begin failure or verified
owned rollback; unexpected inactive/unreadable state, uncertain commit, or
unproven cleanup is **INDETERMINATE**, non-retryable, and invalidates/closes the
connection. Only SQLite busy errors with a known rolled-back/no-write outcome
are retryable. Busy waiting remains bounded; a separate-process writer test
checks this. SQLite extended busy codes are classified by their primary code.

The primitive owns the connection authorizer for its duration. The raw private
store connection is privileged setup/test authority, not a callback capability.
Deliberately replacing its authorizer or using a separate privileged connection
is outside the prevention boundary; unexpected transaction state is nevertheless
detected conservatively. Independent privileged connections are not sandboxed.

Promise/thenable results are rejected and their rejection is observed without
making the helper async. Native Promises are observed through the native method,
not an overridden `.then`. Rollback and capability revocation occur synchronously;
async continuations and retained statements cannot use the owned handle, even
when the connection is reused later. Detached async work not returned by the
callback, or a separately captured privileged raw connection, is not sandboxed.

F6 failed-initialization artifact recovery, F8 general budgets, F9 architecture
negative-oracle hardening, and all B2 features remain deferred.
