[English](storage-contract.md) | [简体中文](storage-contract.zh-CN.md)

# Durable storage contract (CE-0002-B2-S6-2)

Historical contract and amendments for the accepted private SQLite durable storage of
Chat Exchange. Every normative claim below is backed by accepted test or
implementation evidence; see the traceability matrix at the end.

## E2-A current-only v7 implementation candidate

This section supersedes historical version/migration requirements below for the
E2-A implementation candidate; parent review/acceptance remains pending.

Fresh stores use the complete direct final `src/storage/current-schema.ts` v7
foundation, not historical COPY/DROP/RENAME composition. The one fresh ledger row
is `(7, b3-p3b-direct-current-ack-foundation,
fd07d7a0e65183700c7f71e1f5522c59ef053f1e316eb4bb93596f5b3309b5b1)`.
Metadata initialization version and user_version are both 7. Exact schema, ledger,
identity, integrity, foreign keys, restore-hold and host trust root are validated
before COMMIT and again before publishing a handle. A separately pinned static
94-object manifest is in `test/storage/support/current-v7-manifest.json`.

Normal open refuses unsupported/old/mixed shapes with STORAGE_INCOMPATIBLE and
separate operator-approved Dev Reset guidance; it never resets, deletes, repairs,
reinitializes or migrates. Foreign identity, too-new, checksum, corruption,
filesystem, hold and trust-root refusals keep their distinct typed meanings.
Historical SQL/checksums and migration.ts remain unchanged; they are not a v7
upgrade service or an E2-A normal-open prerequisite.

Initialization owns exception-safe connection cleanup, including secret generation.
Failed initialization can leave refused filesystem artifacts; no automatic deletion
or repeat is performed. An uncertain/lost response can leave a complete committed
Store. Failure never by itself proves rollback; fresh full validation is required.

The new private ACK/receipt reconciliation semantics are specified in
[delivery-ack-contract.md](delivery-ack-contract.md). No public ACK transport is added.

Scope labels used throughout:

- **public contract**: behavior callers can rely on;
- **internal**: private implementation detail, not a caller guarantee;
- **test-only**: capability existing only in the test harness;
- **limitation**: known boundary of current evidence;
- **deferred**: recorded future requirement, not implemented.

This document does not change any architecture, production behavior, or test.

Sections below retain their phase-specific claims. Later amendments supersede earlier claims only where stated; historical migration requirements do not override the current-only v7 section above. Storage APIs described as public contracts remain inside the private storage plane unless explicitly exported.

## 1. Storage contract

### Creation APIs (public contract)

`createExchange(store, input)` and `createMessage(store, input)` are
synchronous. Both return a frozen result `{ disposition, entity, record }`
where `disposition` is `"CREATED"` or `"REPLAYED"` (`ExchangeCreation`,
`MessageCreation` in `src/storage/creation.ts:24`, `:214`).

- `createExchange` creates an Exchange row, an idempotency record, and one
  `exchange_opened` audit event with sequence 1, in a single owned
  transaction (implementation: `creation.ts:120`, audit insert at `:178`).
- `createMessage` creates a Message row, an idempotency record, and one
  `message_created` audit event with a per-Exchange consecutive sequence,
  in a single owned transaction (implementation: `creation.ts:382`,
  sequence selection at `:346`, audit insert at `:456`).
- Message identities are `msg_`-prefixed, audit identities `evt_`-prefixed
  (test: M2 in `test/storage/message-creation.test.ts`).
- All three rows are visible to an independent read-only connection after
  COMMIT (test: M6).

### Public result shapes (public contract)

A created or replayed Message exposes legitimate public fields only:
`messageId`, `exchangeId`, `from`, `to`, `payloadDigest`, `payloadLength`,
`createdAt`, `state`, plus the enclosing `disposition` and idempotency
`record`. Endpoint identities (`from`, `to`) are **public by accepted M3
contract**: the stored endpoint is embedded in the replayed Message and
persisted exactly as requested (test: M3). Results are deeply frozen
(test: M5).

### Private payload handling (public contract)

The payload body is stored privately. Public results expose only the digest
and length: never payload bytes, and no payload accessor (tests: SB6,
M3, and the S6-1 sweep). An empty payload is stored as a zero-length body
(test: M7); the maximum authorized size is accepted (M8); oversized payloads
are rejected before any transaction starts (M9).

### Idempotency and replay (public contract)

The idempotency key is scoped per Exchange with no in-memory state (test:
I7). Repeating the same key with the identical request replays the original
Message: `REPLAYED` disposition, preserved creation metadata and current
stored state, zero writes, no hook invocation (tests: I1, I2, I3). Replay
works after Store close/reopen and across concurrent processes (test: R4 in
`test/storage/message-creation-recovery.test.ts`).

### Conflict (public contract)

The same key carrying a different request (different payload or endpoint)
is a nonretryable conflict: never a replace (tests: I4, I5; C2 race and
serialized cases). A valid request conflicting with a stored different
request is a conflict, not corruption (I8).

### Exchange admission (public contract)

New creation is refused when the Exchange is missing (A1), CLOSED (A3), or
carries a disposition row (A4; implementation: `creation.ts:334`). Zero-write
replay remains allowed after CLOSED or disposition (A5, A6); conflict
classification survives CLOSED admission without consulting it (A7). Externally
committed disposition changes are observed through the open Store without
reopening (tests: F2-A, F2-B, F3).

### Transaction ownership and outcomes (public contract)

All mutations run inside `withImmediateTransaction`: a synchronous,
exclusive owner of the connection (internal primitive; contract documented in
`docs/storage-security.md` and covered by `transaction*.test.ts`). Public
error classes are `CreationDomainError`, `StorageTransactionError`, and
`ConditionalMutationError`, with fixed sanitized messages and codes
(implementation: `creation.ts:50`, `transaction.ts:6`, `:26`).

- **BUSY**: a contended transaction is classified
  `STORAGE_TRANSACTION_BUSY`, outcome `ROLLED_BACK`, retryable (test: S6-1
  "BUSY classification errors …").
- **ROLLED_BACK**: a failed COMMIT with a proven rollback produces
  outcome `ROLLED_BACK` and no fabricated success (S6-1 commit-failure test).
- **INDETERMINATE**: a failure of the owned ROLLBACK itself yields
  `STORAGE_TRANSACTION_FAILED`, outcome `INDETERMINATE`, non-retryable, and
  the connection is invalidated; subsequent calls repeat the same sanitized
  classification (S6-1 uncertain-rollback test; helper mechanics at
  `transaction.ts` `invalidated` WeakSet). INDETERMINATE does **not**
  guarantee zero durable writes; observed zero-write state belongs only to
  the controlled test fixtures (limitation).

### Audit behavior (public contract)

Exactly one audit event per successful creation; replay performs zero
audits (I3). Message audit sequences are consecutive per Exchange (C3).
Corrupt or unexpected durable history is refused, never repaired (P3;
`a51c091` unsafe-integer classification).

### Durable storage boundaries (public contract)

Storage is private to the package: the public entry point re-exports
protocol/core only (`src/index.ts:7-10`), and the contract gate enforces
the private storage boundary (19 negative fixtures; Wayforge 19 architecture
gates). Filesystem, refusal, schema-manifest, and snapshot-preflight
boundaries are documented in `docs/storage-security.md`.

## 2. Crash and recovery evidence

Accepted committed regression evidence:

- **K1–K6 boundary markers**: creation is provably committed only after the
  full transaction completes; a crash before the boundary leaves no durable
  triple, and a crash after a proven COMMIT keeps the durable result with
  retry replaying it (K6; crash suite in
  `test/storage/message-creation-crash.test.ts`, commit `b3141ca`).
- **SIGKILL lock release**: a killed writer releases its write lock and a
  later process creates cleanly (R1-A, commit `f178dec`).
- **Contention during death**: a contender blocked on BEGIN IMMEDIATE
  resolves safely when the holder dies (R1-B).
- **Reader snapshot isolation**: an open reader transaction is unaffected by
  a writer's uncommitted work and SIGKILL (R2).
- **Store close/reopen and concurrent replay**: durable idempotency replays
  through close/reopen and concurrent processes with zero duplicate writes
  (R4, commit `bbf28f0`).
- **K5 crash**: committed history survives; the uncommitted triple is absent
  (R3).

**Distinction that must not be blurred (limitation):** in the accepted K5
scenario the WAL file is zero bytes at crash time: K5 is an *uncommitted
rollback* scenario. A zero-byte WAL does **not** prove the physical location
of uncommitted pages. *Non-empty committed-WAL recovery* has independent
review-harness evidence (45,352 WAL bytes surviving SIGKILL in the S5-2
review probe) but is **not part of the accepted committed regression suite**;
that is recorded as `CE-STORAGE-WAL-RECOVERY-REGRESSION`.

## 3. Privacy contract

**Legitimate public fields** (not leaks): `messageId`, `exchangeId`,
`from`, `to`, `payloadDigest`, `payloadLength`, `createdAt`, `state`,
`disposition`. Endpoint identities are public per the accepted M3 contract.

**Prohibited disclosures** on any public result or error: payload bytes (in
hex, decimal-sequence, `Uint8Array`, or `Buffer` form), credentials, database
paths, raw SQL, and internal exception causes (`cause` properties). Public
errors carry fixed vocabulary; `Error.stack` may exist but must not contain
protected information.

Accepted S6-1 regression coverage (`test/storage/public-surface-privacy.test.ts`,
commits `84e0603`, `f606594`): sweeps CREATED and REPLAYED Message results,
REPLAYED Exchange results, and eight error paths (conflict, invalid request,
admission rejection, BUSY, COMMIT-failure rollback, uncertain-rollback
INDETERMINATE, hook-seam failure), with negative controls proving detection
of each sentinel class (including binary payload forms) and a false-positive
control for legitimate public fields. Production cause-leak mutation
sensitivity was demonstrated: mutating the **createMessage** wrap site fails
4 tests (exit 1).

**Non-blocking gap: `CE-PRIVACY-EXCHANGE-ERROR-COVERAGE` (deferred):**
createExchange error paths have no direct privacy assertions; mutating the
createExchange wrap site alone passes the suite. The two APIs do **not** have
identical mutation sensitivity. The shared wrap mechanism and sanitization
assertions are exercised through createMessage paths only.

## 4. Architecture boundaries

Chat Exchange does **not** currently own: model routing, account rotation,
automatic task retries, durable task execution, recovery scheduling, or
cross-plugin orchestration. Chat Exchange message persistence (this contract)
is distinct from Wayforge task durability; neither implies the other. This
document records boundaries; it changes no architecture.

## 5. Deferred register

Existing technical limitations / optional hardening:

- **`CE-STORAGE-IMMUTABILITY-V2`**: Schema v1 lacks authenticated state
  integrity; privileged CLOSED→OPEN drift is characterized but not prevented
  (tests: F4, P4).
- **`CE-STORAGE-WAL-RECOVERY-REGRESSION`**: no committed regression test for
  non-empty committed-WAL crash recovery; evidence is review-harness only.
- **`CE-PRIVACY-EXCHANGE-ERROR-COVERAGE`**: createExchange error paths lack
  direct privacy mutation sensitivity (see §3).

Future product capabilities (not implemented, not designed here):

- **`CE-SESSION-CONTINUITY-001`**: a new Pi Session can safely resume
  participation in an existing Exchange without losing committed messages.
  Current boundary: persisted messages and Store reopening do not by
  themselves provide cross-session continuity; participant takeover is out
  of scope here.
- **`CE-RECONNECT-001`**: recover communication after ChatGPT.app restart,
  update, or temporary disconnection. Distinct layers: persisted Exchange
  state (this contract), Pi-side connection restoration, ChatGPT.app
  integration, and task-execution recovery. ChatGPT.app must not be assumed
  to provide an automatic reconnect lifecycle hook.

B2 scope is not expanded by these entries.

## 6. Traceability matrix

| Contract claim | Test evidence | Accepted commit | Limitation |
| --- | --- | --- | --- |
| Exchange creation: 3 rows, one transaction, audit seq 1 | exchange-creation suite; `creation.ts:120`,`:178` | `deefd8e` |: |
| Message creation: schema-valid CREATED, 3 rows visible | M1, M6 | `deefd8e` |: |
| Public fields incl. endpoints; deep freeze | M3, M5; S6-1 sweep | `deefd8e`, `84e0603` | endpoints are public, not hidden |
| Private payload; digest/length only; no accessor | SB1–SB10, M3, M7–M9 | `deefd8e` |: |
| Idempotent replay: zero writes, metadata preserved | I1–I3, I7 | `deefd8e` |: |
| Conflict nonretryable; no replace | I4, I5, I8, C2 | `deefd8e`, `1250800` |: |
| Admission: missing/CLOSED/dispositioned refused | A1, A3–A8, F2-A/F2-B/F3 | `deefd8e`, `8318b36` |: |
| Transaction outcomes: BUSY/ROLLED_BACK/INDETERMINATE + invalidation | transaction suites; S6-1 error tests | `deefd8e`, `84e0603` | INDETERMINATE ≠ zero-write guarantee |
| Error precedence and corruption refusal | P1–P5 | `5005078`, `a51c091` |: |
| Crash boundaries K1–K6, SIGKILL commit durability | crash suite (19 tests) | `263c191`, `b3141ca` | harness-based process fixtures |
| Lock release, contention, reader isolation | R1-A, R1-B, R2 | `f178dec` |: |
| Close/reopen + concurrent replay | R4, C5 | `bbf28f0`, `1250800` |: |
| K5 uncommitted rollback survives crash | R3 | `bbf28f0` | WAL zero bytes; see CE-STORAGE-WAL-RECOVERY-REGRESSION |
| Public-surface privacy sweep + binary controls | S6-1 suite (18 tests) | `84e0603`, `f606594` | createExchange error paths: CE-PRIVACY-EXCHANGE-ERROR-COVERAGE |
| Private storage boundary / no public export | architecture contract gate (19 fixtures) | (workspace gates) |: |


## 7. B3-P1A schema v2, explicit migration, and host trust root

Accepted B3-P1A amendment (CE-0002-B3-P1A). Everything in §§1-6 is preserved:
every v1 table, trigger, index, and row is untouched; v2 only appends new
schema objects and ledger rows. `store_metadata` is never UPDATEd or DELETEd
(its v1 immutability trigger would abort the attempt);
`store_metadata.schema_version` permanently records the schema version at
initialization (1 for migrated stores, 2 for fresh v2 stores). The live
schema version is `PRAGMA user_version`, which must equal the highest
migration-ledger entry.

### Additive v2 schema

New tables: `participant`, `participant_capability` (SHA-256 digests only,
never plaintext capabilities), `participant_session` (schema only in P1A),
`exchange_membership`, `participant_ownership`,
`participant_fencing_high_water`, `delivery_cursor`, `host_trust_root`.
New append-only/immutability triggers: `participant_identity_immutable`,
`exchange_membership_immutable`/`_nodelete`,
`host_trust_root_immutable`/`_nodelete`. The ownership, fencing, and cursor
tables are inert schema in P1A: no code path reads or writes them before
B3-P2/P3, and a migration test asserts they are empty.

### Version recognition (normal open)

- Recognized pristine v1 (ledger exactly the v1 row, `user_version` 1,
  v1 manifest): refused with `STORAGE_MIGRATION_REQUIRED`: migration is
  never implicit and never runs during a normal open.
- Migrated v2 (ledger v1 row + v2 migration row, `user_version` 2) or fresh
  v2 (single v2 foundation row, `user_version` 2): opens after full
  validation including the host trust root. Migrated and fresh stores share
  one byte-identical approved manifest (`INITIAL_SCHEMA_SQL + V2_ADDITIVE_SQL`).
- `user_version` or metadata version above 2: `STORAGE_SCHEMA_TOO_NEW`.
- Any ledger deviation: `STORAGE_MIGRATION_CHECKSUM_MISMATCH`. Any schema
  drift (extra, dropped, or altered objects, whitespace-level):
  `STORAGE_INCOMPATIBLE`. Refusal-over-repair is unchanged.

### Explicit migration (`migrateStore`)

A dedicated host-local entry point, never reachable from `openStore`:
requires the explicit `{ fromVersion: 1, toVersion: 2 }` path; preflights the
exact v1 shape on a disposable read-only snapshot (integrity, foreign keys,
identity, ledger, manifest, restore hold); bootstraps host trust-root
generation 1; applies the additive DDL, appends the v2 ledger row, and
advances `user_version` inside one owned BEGIN IMMEDIATE transaction; then
proves success by a full v2 reopen. Interruption rolls back to a valid v1
store (still answered by `STORAGE_MIGRATION_REQUIRED`); BUSY / ROLLED_BACK /
INDETERMINATE propagate unchanged with no retry and no repair. A v2 store is
structurally unopenable by a v1 binary (`user_version` 2 exceeds v1's
supported version), so downgrade is impossible.

### Host trust root

The host secret is a 256-bit random value hex-encoded into a `host-secret`
file inside the private store directory: exclusive creation with O_NOFOLLOW,
mode 0600, current-user-owned, no symlinks: the same artifact enforcement
the database itself passes. Only its SHA-256 fingerprint is persisted, in the
append-only `host_trust_root` table. Every v2 open re-reads the file, repeats
the artifact checks, and compares the fingerprint: missing file
`STORAGE_TRUST_ROOT_MISSING`, disagreement `STORAGE_TRUST_ROOT_MISMATCH`,
insecure artifact `STORAGE_TRUST_ROOT_INSECURE`, preexisting secret during
initialization/migration/recovery `STORAGE_TRUST_ROOT_AMBIGUOUS`: all fail
closed with zero writes, no repair, no automatic regeneration, and no secret
or fingerprint material in any error, result, or log surface.

### Trust-root recovery (`recoverTrustRoot`)

Explicit operator-authorized only: the operator removes any old secret file
first (the command refuses to overwrite one); the store must be a valid v2
store; one owned transaction appends generation N+1 with the new fingerprint
and revokes every existing capability row. A replacement secret inherits no
authority: previous-generation capabilities fail by revocation and by
generation binding, and fresh capability issuance is required per
Participant. Capability issuance itself is B3-P1B scope and does not exist
yet.

### Limitations

Protection equals the documented filesystem trust boundary
(`storage-security.md`): an attacker controlling both the database and the
secret file can rewrite both consistently, and no protection against that
actor is claimed. `CE-STORAGE-IMMUTABILITY-V2` remains open and unchanged;
the new v2 tables inherit the same unauthenticated-state limitation.


## 8. B3-P1B Participant identity, capability authorization, and membership

Implemented B3-P1B amendment (CE-0002-B3-P1B). Everything in §§1-7 is
preserved: no v1 DDL, trigger, index, or row changes, no schema-v2 manifest
change (P1B uses only tables the accepted v2 schema already defines), no
change to B2 creation, request digests, idempotency/conflict semantics, audit
ordering, or transaction classification. The ownership, fencing, and cursor
tables remain inert.

### Participant identity (public contract within the private plane)

`createParticipant` creates one durable, globally unique Participant
(`prt_<ULID>`, generated by the frozen protocol ULID encoder) immutably bound
to exactly one stable Endpoint identity `(adapter, endpointId)`. Identity and
binding are immutable (`participant_identity_immutable`), the binding is 1:1
(`UNIQUE (endpoint_adapter, endpoint_id)`), a second Participant for the same
Endpoint identity is refused (`PARTICIPANT_ENDPOINT_CONFLICT`), and no
reassignment or aliasing exists. A Session ID is never an identity:
`participant_session` stays unused in P1B. `instanceId` is ephemeral: it is
excluded from identity, from the request digest, and from the persisted
binding, so a differing incarnation replays instead of conflicting. Creation
is idempotency-keyed with the accepted B2 semantics (replay, conflict,
corruption-before-conflict). No audit event is emitted: `audit_event` is
Exchange-scoped by the accepted v1 DDL and Participant identity is global.

`bindEndpointRef` is the authorized affirmation of that immutable binding: it
requires a `bind` capability, performs zero writes, refuses a different
Endpoint identity (`PARTICIPANT_BINDING_MISMATCH`) and an Endpoint identity
owned by another Participant (`PARTICIPANT_ENDPOINT_CONFLICT`), and ignores
`instanceId`.

### Host Capability authorization

Only the P1 scopes `create`, `bind`, and `join` are operational; the remaining
accepted schema scopes are refused with `CAPABILITY_SCOPE_UNSUPPORTED`. A
capability is a 256-bit CSPRNG bearer token (`cap_<64 hex>`) returned once to
the issuing host. Only an HMAC-SHA256 digest keyed by the host secret is
persisted, bound to the current trust generation, the Participant, and the
exact scope. Verification happens inside the same owned transaction as the
mutation it authorizes and re-validates the host trust root (artifact policy
plus fingerprint agreement) on every authorization. Forged, unknown,
wrong-scope, wrong-Participant, wrong-generation, revoked, and expired
capabilities are all refused with the single opaque `CAPABILITY_REJECTED`
classification, so the refusal is not an oracle; the host-local
`readCapabilityStatus` read retains the detail. Session IDs and Participant
IDs never authorize anything. Since CE-0002-B3-P2C-B a Session-bound
capability (`resume`, `takeover`; the future `send`/`ack`/`read` scopes
inherit this when they become operational) whose bound Session is DETACHED
is equally unusable: the persisted `detached_at` is the lifecycle source of
truth, invalidated at read time with no capability-row rewrites, and the
host-local status identifies `SESSION_DETACHED` while callers see the same
opaque classification. A Session-bound capability whose binding row is
missing or malformed refuses `STORAGE_OWNERSHIP_CORRUPT`. Revocation is
explicit and one-way; there is no
automatic capability recovery. After an operator trust-root recovery, previous
capabilities fail both by revocation and by generation binding, and fresh
issuance is required per Participant.

### Exchange membership and the join boundary

`joinExchange` requires a valid `join` capability, verifies the Participant,
and admits only an existing OPEN Exchange without an administrative
disposition. It writes one `exchange_membership` row, one idempotency record,
and exactly one `participant_joined` audit event, allocating the sequence
through the accepted per-Exchange MAX(sequence)+1 discipline and persisting it
as the immutable `join_boundary_seq`. Membership rows are immutable and
undeletable (`exchange_membership_immutable`/`_nodelete`). A duplicate join is
a zero-write replay that never moves the boundary; the same key with a
different request is `IDEMPOTENCY_KEY_CONFLICT`. Historical Message rows are
never rewritten: audit sequences below the boundary are pre-join history and
sequences above it are post-join activity. Keys are Exchange-scoped, so one
Participant may join many Exchanges and one Exchange may hold many
Participants.

**Membership eligibility is not delivery.** P1B provides no message listing,
no delivery, no cursor or ACK behavior, and no adapter wiring; the delivery
plane remains unauthorized B3-P2/P3 scope.

### Durable reads

Minimal private reads only: Participant existence, stable Endpoint binding,
Exchange membership with its join boundary, and host-local capability status.
Nothing is added to the public package surface: the private storage boundary
and its contract gate are unchanged.

### Interpretation notes

- The `create` scope is operational through optional sponsored creation: when
  `createParticipant` receives a `sponsor`, that sponsor's `create` capability
  is verified in the same owned transaction. Making `create` gate accepted B2
  Exchange/Message creation would change accepted B2 contracts and is
  therefore out of scope.
- `participant_joined` is a private storage audit kind. The frozen protocol
  `EVENT_KINDS` vocabulary and `prt_` identity prefix are deliberately not
  added to the publicly re-exported protocol surface; `audit_event.kind` is
  free text in the accepted v1 DDL.

### 8.1 R1 remediation (CE-0002-B3-P1B-R1)

Remediation of the independent B3-P1B review. No schema change, no new
dependency, no public export, no P2 scope.

**Authorization precedes every protected result.** `joinExchange` and sponsored
`createParticipant` previously evaluated the idempotent replay path before
capability verification, so a caller holding a known idempotency key could
obtain a `REPLAYED` Membership or Participant result while presenting a forged,
expired, revoked, wrong-scope, wrong-Participant, or wrong-generation
capability. Current authorization now runs first, inside the same owned
transaction, for both newly created and replayed results. An idempotency key is
never an authorization credential.

**Deliberate error-precedence change.** On these two paths
`CAPABILITY_REJECTED` now outranks replay, `IDEMPOTENCY_KEY_CONFLICT`, and
`STORAGE_IDEMPOTENCY_CORRUPT` classification. Within the authorized replay path
the accepted corruption-before-conflict ordering is unchanged. Unsponsored
`createParticipant` is a trusted host-local operation and keeps its accepted
semantics with no capability requirement.

**Idempotency is unchanged otherwise.** An authorized replay remains
zero-write, deterministic, byte-identical, and boundary-preserving, and emits
no audit event, no capability record, and no ownership change. The B2 request
digest and B2 Exchange/Message behavior are untouched.

**`bindEndpointRef` is validation-only.** The accepted name is kept; the
operation never creates or changes a binding. The binding is established once,
atomically with identity creation.

**Trust-root classification is aligned.** During capability verification, a
missing trust-generation row is `STORAGE_CORRUPT` and a host-secret fingerprint
disagreement is `STORAGE_TRUST_ROOT_MISMATCH`: typed trust-root refusals, as
the capability plane already documented and as `issueCapability` already
behaved. Capability refusals themselves stay a single opaque
`CAPABILITY_REJECTED`, and both paths fail closed with zero writes.

**`recoverTrustRoot` corruption classification.** When the owned transaction
proves a non-retryable rollback caused by a typed lifecycle refusal, that
refusal is now the top-level classification (for example `STORAGE_CORRUPT`
instead of a generic transaction failure). The transaction outcome, its
non-retryable classification, and the original transaction error remain
available as the preserved `cause`. BUSY, INDETERMINATE, and unclassified
outcomes propagate exactly as before; nothing is retried or repaired.

## 9. B3-P2A Session binding, ownership, leases, and fencing

Implemented B3-P2A amendment (CE-0002-B3-P2A). Everything in §§1-8 is
preserved: no DDL, trigger, index, or schema-v2 manifest change (P2A writes
only the accepted v2 tables `participant_session`, `participant_ownership`,
and `participant_fencing_high_water`), no change to B2 creation, P1A
migration/recovery, P1B identity, Endpoint binding, membership, join
boundaries, or audit ordering. `delivery_cursor` stays inert. Nothing is
added to the public package surface; there is no delivery API, no adapter
wiring, no background heartbeat, and no takeover.

### Scopes

`attach` and `resume` become operational. `attach` authorizes Session
binding and ownership acquisition; `resume` authorizes renewal, release, and
zero-write Owner verification. `takeover`, `send`, `ack`, and `read` remain
`CAPABILITY_SCOPE_UNSUPPORTED`. Authorization always runs in the same owned
transaction as the mutation and re-validates the host trust root.

### SessionRef and binding

A Session is an opaque, non-secret `ses_<ULID>` SessionRef. It is never a
Participant identity and never a credential. `bindSession` records one
`(participant, session)` row under an `attach` capability; binding confers no
ownership, a duplicate binding is `SESSION_ALREADY_BOUND`, and a Session
bound to another Participant is `SESSION_BOUND_TO_OTHER_PARTICIPANT` (a
Session belongs to exactly one Participant; a Participant may hold many
historical Sessions). Participant creation never creates a Session or
ownership. P2A never detaches Sessions; a detached row is treated as not
bound.

### Ownership and fencing

`acquireOwnership` makes one bound Session the single current Owner of a
Participant with no current Owner. A live lease, including one held by the
requesting Session itself, is `OWNERSHIP_HELD`: no silent adoption, no
takeover. Acquisition allocates the fencing token and writes the ownership
row in one owned transaction. **Superseded by §10:** the P2A text here
allowed acquisition over an *expired* row ("supersession"); R1 (design
clarification Q1) moves every replacement of an existing Owner to the
inactive P2B `takeover` scope.

**First-token rule:** with no `participant_fencing_high_water` row the first
acquisition allocates token 1 and inserts the row; every later acquisition
allocates exactly high-water + 1 (compare-and-set on the previous value).
The high-water row is never decremented or deleted, so tokens survive
restart, lease expiry, and release and are never reused; counters are per
Participant. Allocation past `Number.MAX_SAFE_INTEGER` is
`FENCING_EXHAUSTED`. Tokens are never derived from timestamps or Session IDs.
An ownership row whose token differs from the high-water, a missing
high-water row, an out-of-range stored token, an invalid stored deadline, or
an ownership row for an unbound Session is `STORAGE_OWNERSHIP_CORRUPT` —
refused, never adopted or repaired.

### Owner authorization and leases

Renewal, release, and verification verify, in order: a currently valid
`resume` capability (Participant, scope, trust generation, revocation,
expiry), the Participant, a bound Session, the Session being the durable
current Owner (`OWNERSHIP_NOT_CURRENT`), the presented fencing token being
current (`FENCING_STALE`), and the lease (`LEASE_EXPIRED`,
`LEASE_CLOCK_REGRESSION`). Ownership is never inferred from a Session ID.
After a takeover (§11) every Owner operation by the previous Session is refused.

Default TTL 120 s, configurable 30–3600 s (request-validated). 30 s is a
renewal recommendation for hosts, not a scheduler. Time comes only from the
injected clock. Release removes only the ownership row.

**Superseded by §10:** the P2A text here derived the term start as
`expiresAt - ttl` from the *request* TTL and claimed a rolled-back clock
could never extend a lease. The independent review (MAJOR-1) showed both the
derivation and the claim were unsafe: a request TTL change falsely refused
live Owners as `LEASE_CLOCK_REGRESSION`, and a rollback presented with a
larger TTL could renew and extend. R1 persists the term start. A rollback
that lands inside the current term remains indistinguishable from a valid
instant (refusals are zero-write).

### Durable reads

Private host-local reads only: `readSessionBinding`, `readSessionBindings`,
`readCurrentOwnership` (the durable row regardless of expiry),
`readFencingHighWater` (0 when never allocated), and `readLeaseStatus`
(`UNOWNED`/`ACTIVE`/`EXPIRED`/`CLOCK_REGRESSION`). Each runs against one
read snapshot and applies the same consistency validation.

### P1B hardening pins

The four MINOR gaps from the P1B-R1 final gate are regression-pinned:
missing trust generation during capability verification (`STORAGE_CORRUPT`
on join, bind, sponsored create, and Session attach); corruption-before-conflict
on authorized join and sponsored-create replay; each `recoverTrustRoot`
unwrap guard (the classifier was extracted unchanged as
`classifyRecoveryFailure` and is unit-pinned, plus end-to-end BUSY,
unclassified-rollback, and typed-rollback cases); and the sponsored replay
negative authorization matrix.

## 10. B3-P2A-R1 lease term persistence, acquisition boundary, and schema v3

Remediating amendment (CE-0002-B3-P2A-R1), governed by the versioned P2
ownership contract (`docs/ownership-contract.md`, decisions Q1–Q5). Everything
in §§1-9 is preserved except where §10 explicitly supersedes §9.

### Schema v3 (additive, explicit migration only)

- `participant_ownership.lease_started_at TEXT` (nullable): the persisted
  start of the current lease term, written at acquisition and updated at every
  renewal. NULL marks a legacy v2 row, which is treated as expired at every
  instant: no lease start is fabricated from an untrusted TTL and no v3
  operation authorizes against a legacy row.
- `participant_capability.session_id TEXT` (nullable): the durable Session
  binding of a `resume` capability. NULL for every other scope and for legacy
  v2 rows; a legacy unbound resume capability can never authorize (fail
  closed).
- `participant_session_unique_session_id`: durable uniqueness of a Session
  across Participants. The v2→v3 migration refuses (`STORAGE_CORRUPT`, zero
  writes) when historical rows bind one Session to more than one Participant;
  conflicting history is rejected, never repaired.
- Migration paths are explicit and approved: v1→v2 (accepted P1A, unchanged),
  v2→v3, and the chain v1→v3. Each step commits independently; interruption
  rolls back the interrupted step only. The v2→v3 step re-validates the
  existing trust root and never creates, rotates, or deletes the host secret.
  Normal open requires the current v3 shape; v1 and v2 stores refuse with
  `STORAGE_MIGRATION_REQUIRED`. Fresh v3 and migrated v3 stores converge to a
  byte-identical schema manifest.

### Lease term model (supersedes §9's derived term start)

Lease evaluation compares the operation clock against the persisted
boundaries `[leaseStartedAt, expiresAt)` only. A request TTL (default 120 s,
allowed 30–3600 s) is used solely to compute a *new* expiry at acquisition or
renewal and never reinterprets a stored term. `verifyOwnership`,
`releaseOwnership`, and `readLeaseStatus` no longer accept a TTL. Renewal sets
`lease_started_at = now` and refuses to shorten the term
(`LEASE_TERM_SHORTENED`). Exact-expiry refusal is preserved. A wall-clock
rollback before the persisted term start is `LEASE_CLOCK_REGRESSION` and can
never renew or extend a lease; a rollback inside the current term remains
undetectable (documented limitation, zero-write refusals).

### Acquisition boundary (design clarification Q1)

`acquireOwnership` is admitted only when no ownership row exists for the
Participant. Any existing row refuses acquisition: `OWNERSHIP_HELD` while the
lease is live at the operation's clock, `OWNERSHIP_TAKEOVER_REQUIRED` once
expired (including legacy v2 rows). A refused acquisition allocates no fencing
token. **Updated by §11:** CE-0002-B3-P2B activated the `takeover` scope and
implemented explicit takeover; the acquisition boundary itself is unchanged.

### Session-bound resume (design clarification Q2)

A `resume` capability is issued for exactly one currently bound Session
(`sessionId` required at issuance, refused for other scopes) and authorizes
only that Session; classification adds the host-local detail
`SESSION_MISMATCH`. Revoking a resume capability requires presenting its bound
Session. The Session binding narrows authority; it is never a credential, and
no operation is authorized by a Session ID alone.

### Regression coverage (R1)

New real-SQLite pins cover: TTL-independent term evaluation (no false
`LEASE_CLOCK_REGRESSION`), rollback-plus-TTL-widening refusal, persisted term
start on renewal, exact-expiry refusal, expired-Owner renew/release refusal,
expired-Owner acquisition refusal (`OWNERSHIP_TAKEOVER_REQUIRED`), initial
acquisition, fencing monotonicity across release and restart, restart
persistence, v2→v3 migration with legacy-row policy, fresh/migrated manifest
convergence, conflicting-history migration refusal, durable Session
uniqueness, a multi-process renewal-vs-acquisition race, missing trust
generation across all ownership operations, and BUSY/ROLLED_BACK/
INDETERMINATE classification with privacy and zero-write refusals.

## 11. B3-P2B durable takeover, supersession, and reconciliation

Additive amendment (CE-0002-B3-P2B). No schema change: takeover reuses the
accepted v3 columns. Everything in §§1-10 is preserved except where §11
explicitly updates §10. CE-0002-B3-P2B-R1 amends this section further (see
"Transaction-time clock sampling" below), remediating the independently
confirmed stale pre-lock clock defect without changing any takeover
authority, eligibility, fencing, supersession, or reconciliation contract.

### Takeover authority

The `takeover` capability scope is operational and Session-bound, consistent
with the accepted resume model: issuance requires `sessionId` naming a
currently bound Session of the Participant (the prospective new Owner),
`sessionId` is refused for non-Session-bound scopes, classification compares
the durable binding inside the mutation's transaction (`SESSION_MISMATCH`),
and revocation requires presenting the bound Session. A Session ID alone
never grants takeover authority; the bearer token, Participant binding,
scope, trust generation, revocation, and expiry checks are unchanged.
`send`/`ack`/`read` remain `CAPABILITY_SCOPE_UNSUPPORTED`.

### Takeover eligibility

`takeoverOwnership` replaces an EXISTING ownership row whose lease is expired
at the operation's clock, including a legacy v2 row (NULL `lease_started_at`,
expired at every instant). It refuses: a live Owner (`OWNERSHIP_HELD`,
evaluated against the persisted term: one millisecond before expiry still
refuses, exact expiry is eligible); a clock-regressed lease
(`LEASE_CLOCK_REGRESSION`); a Participant with no ownership row
(`OWNERSHIP_TAKEOVER_INELIGIBLE`: initial acquisition remains the `attach`
operation); corrupt ownership state (`STORAGE_OWNERSHIP_CORRUPT`, never
repaired); and any invalid, revoked, expired, wrong-Participant,
wrong-Session, wrong-scope, or wrong-generation capability
(`CAPABILITY_REJECTED`). There is no force takeover of a live Owner in this
phase.
### Transaction-time clock sampling (B3-P2B-R1)

**Updates §10 lease-time wording and resolves the R1 review's MINOR-1.** P2B
sampled each operation's clock before `BEGIN IMMEDIATE`; an operation that
waited for the SQLite writer lock then evaluated authorization and lease
state against the stale pre-lock instant (the independently confirmed
MAJOR-1: a renewal initiated before expiry but serialized after it committed
and revived an expired lease; a capability that expired during the wait was
accepted).

R1 defines one authoritative operation-time sampling point for every owned
mutating transaction: inside the transaction, after `BEGIN IMMEDIATE` has
acquired the writer lock: `BEGIN IMMEDIATE → sample now → validate
authority → evaluate current state → mutate → COMMIT`. All checks within one
mutation use this one consistent instant. This governs `bindSession`,
`acquireOwnership`, `renewLease`, `releaseOwnership`, `verifyOwnership`,
`takeoverOwnership`, and the capability/membership mutations
(`createParticipant` sponsor authorization, `bindEndpointRef`,
`issueCapability`, `revokeCapability`, `joinExchange`). Lease start and
expiry derive from the transaction-time clock; capability expiry is
evaluated at the transaction-time clock, so a capability that expired during
a lock wait is never accepted. Request validation (shape, TTL range,
identities) still precedes the transaction and performs no state-dependent
check.

Lock-wait semantics, now defined: a renewal initiated before expiry but
serialized after it refuses `LEASE_EXPIRED`; a takeover initiated before
expiry but serialized after it is eligible and may win; a takeover
serialized while the lease is live refuses `OWNERSHIP_HELD`; a capability
that expired during the wait refuses `CAPABILITY_REJECTED`. Every such
refusal is zero-write and allocates no fencing token.

Preserved: exact-expiry behavior (`now >= expiresAt` is expired),
clock-regression refusal, the injected-clock test seam (invoked at the
transaction-time sampling point), and the documented wall-clock limitation —
a rollback landing inside the current term remains indistinguishable from a
valid instant; no cross-transaction monotonic clock is claimed, no scheduler
and no global clock is introduced. B2 Exchange/Message creation samples its
clock during candidate generation, before `BEGIN IMMEDIATE` (wording
corrected by CE-0002-B3-P2C-A); its timestamps are recorded creation metadata
that authorize nothing, and the accepted B2 contract is unchanged.
Migration/recovery/initialization `appliedAt` ledger timestamps likewise
authorize nothing and are unchanged. Regression pins:
`test/storage/lease-lock-wait.test.ts` (real OS processes, real writer-lock
contention, observable initiation, deadline waits). Worker initiation
markers are published atomically (CE-0002-B3-P2C-A-R1): the complete
marker is staged beside its final path and renamed into place, so a
parent can never read a partially written marker; the scenarios and
timing assertions are unchanged.

### Atomic replacement and fencing transition

Eligibility, fencing allocation, and the Owner replacement are one owned
IMMEDIATE transaction: the high-water advances by exactly one (compare-and-set
on the previous value, `FENCING_EXHAUSTED` at the ceiling) and the ownership
row is rewritten in place (new Session, new token, `lease_started_at = now`,
`expires_at = now + ttl`), guarded by the exact pre-read values so any
interleaved change fails the single-row check and rolls back. Exactly one
concurrent takeover wins; losers serialize into `OWNERSHIP_HELD` or time out
as `STORAGE_TRANSACTION_BUSY` (retryable). No partial fencing allocation, no
partial replacement, no token reuse, zero-write refusals. A takeover racing a
renewal of a live lease refuses whenever the lease is live at the takeover's
serialization instant (see "Transaction-time clock sampling" below): a live
lease at serialization is `OWNERSHIP_HELD`, regardless of what the clock read
at initiation. A renewal serialized while its lease is still live extends it;
a renewal serialized after expiry refuses `LEASE_EXPIRED` and can never revive
it. A renewal/takeover race is therefore decided by the durable lease state at
each operation's own serialization instant: exactly one winner, no
stale-time distortion in either direction.

### Supersession

After a successful takeover the previous Session is no longer the current
Owner: its fencing token is stale (`FENCING_STALE`), its `resume` capability
cannot renew, release, or verify the new Owner (`OWNERSHIP_NOT_CURRENT`: the
durable ownership row decides, never the Session ID). Historical Session
bindings are preserved for audit continuity. Takeover never creates a
Participant, never rewrites Endpoint bindings, Exchange membership, join
boundaries, or audit history, and never mutates capability rows.

### Recovery and reconciliation

An uncertain takeover outcome (for example an INDETERMINATE transaction
result) is reconciled explicitly through `reconcileTakeover`, a zero-write
read that compares the evidence the caller presents (Participant, target
Session, the exact persisted term boundaries, optional fencing token) against
the durable row in one consistent snapshot: never a Session ID alone:

- `COMMITTED`: the current row matches the presented evidence exactly. This is
  effect-level recognition of the durable state, not operation-level
  attribution of one invocation and not an exactly-once claim: a retry of the
  same logical request persists identical evidence, so the match cannot say
  which invocation wrote the row. Do not retry. A later authorized takeover or
  renewal may still supersede this term afterwards.
- `NO_TRACE`: the current state carries no trace of the presented evidence (no
  row, a legacy row, a different Owner Session, or a same-Session row whose
  term predates the presented evidence). This is **not** proof that the
  original invocation never committed: a request that did not commit, a
  refused request, and a committed request whose effects were later superseded
  are indistinguishable post-hoc. A fresh attempt is safe only because it is
  freshly authorized and eligibility-checked, never because `NO_TRACE` proved a
  non-commit.
- `EVIDENCE_CONFLICT`: the target Session is the current Owner under
  different term or token evidence: the current state was installed by a
  different request. Never auto-retry; operator review.

Documented limitations (fail-closed, no invented exactly-once semantics): a
refused and a rolled-back takeover leave identical durable state; a committed
takeover later superseded reports `NO_TRACE`; a committed retry with identical
parameters is the same logical request and indistinguishable from the
original commit. There are no background recovery workers.

#### Evidence availability after an uncertain outcome

`takeoverOwnership` samples its operation clock **inside** the owned
`BEGIN IMMEDIATE` transaction (see "Transaction-time clock sampling" above).
That instant is not an ordinary caller-supplied request field: `leaseStartedAt`
is exactly that sample and `expiresAt` is `sample + ttl`. The exact term is
therefore normally available to the caller only from the successful return
value of `takeoverOwnership`, or when the caller itself supplies and records
the operation clock seam. A caller using the default wall clock whose call
ended INDETERMINATE does **not** know the exact term, and pre-call wall-clock
sampling does not reconstruct it (the sample is taken after the writer lock is
acquired, a lock wait of unrecorded, caller-unknown duration later).

`reconcileTakeover` currently requires `participantId`, `sessionId`,
`leaseStartedAt`, and `expiresAt`; `fencingToken` is optional. A caller must
not fabricate, estimate, or round term boundaries to satisfy that input shape:
a term guessed later than the durable one misreads a committed takeover as
`NO_TRACE`, and a term guessed earlier misattributes a same-Session row as
`EVIDENCE_CONFLICT`. When exact term evidence is unavailable the outcome simply
remains unknown to the caller. `reconcileTakeover` accepts no UNKNOWN input and
returns no UNKNOWN disposition: preserving that uncertainty is a caller-level
judgment, not an existing API disposition, and the three dispositions above
keep their exact meanings.

INDETERMINATE is not ROLLED_BACK. A connection invalidated by an indeterminate
transaction outcome must not be reused; recovery inspection requires a freshly
opened store. A lost acknowledgement never authorizes a blind retry.

A caller may also snapshot `readFencingHighWater` for the Participant before
the call. If a later valid read of the same Participant still returns the same
value, then no fencing allocation: and therefore no successful takeover or
acquisition for that Participant: committed between the two reads, assuming
both reads are valid, correctly ordered, and about the same Participant. An
increased high-water proves only that some allocation committed; it never
identifies which invocation committed, never proves that this caller's takeover
committed, and never establishes a durable ownership lease (only the ownership
row does). High-water evidence is effect-level only.

`reconcileTakeover` still has no production caller
(CE-TAKEOVER-RECONCILIATION-EVIDENCE-001): a real-clock caller cannot
reconstruct exact term evidence after an INDETERMINATE result and therefore
must not fabricate evidence or retry blindly.

CE-TAKEOVER-RECOVERY-CALLER-001 is resolved by the explicit operator-only
caller in `src/host/ownership-recovery.ts` and
`scripts/recover-stale-ownership.mjs`. It requires an exact Endpoint plus the
operator-confirmed old Session, fencing token, lease start, and expiry. It
refuses absent, mismatched, clock-regressed, or live ownership before recovery
writes; uses only `bindSession`, Session-bound capabilities,
`takeoverOwnership`, `releaseOwnership`, and `detachSession`; preserves
monotonic fencing; and emits a capability-free structured receipt. It is not
an MCP/Pi tool and is never invoked by normal host startup. Any unknown outcome
stops for fresh durable inspection without automatic retry.

### Legacy ownership recovery

A migrated v2 ownership row (NULL `lease_started_at`) never authorizes as a
live lease and is never repaired. It is takeover-eligible: an explicit
Session-bound takeover replaces it with a fully persisted v3 term
(`lease_started_at = now`), allocating the fencing token strictly greater
than the legacy token (the v2 high-water survives migration untouched).

## 12. B3-P2C-A irreversible Session lifecycle and schema v4

Additive amendment (CE-0002-B3-P2C-A), governed by the accepted
CE-0002-B3-P2C-D0 design and recorded in `docs/ownership-contract.md`.
Everything in §§1-11 is preserved. No detach operation, no capability scope
change, no delivery.

### Schema v4 (additive triggers, explicit migration only)

`V4_ADDITIVE_SQL` appends seven triggers and nothing else:
`participant_session_insert_attached`, `participant_session_nodelete`,
`participant_session_identity_immutable`, `participant_session_detach_once`,
`participant_session_detach_not_owner`,
`participant_ownership_session_attached_insert`, and
`participant_ownership_session_attached_update`. Fresh initialization applies
`V4_FOUNDATION_SQL = V3_FOUNDATION_SQL + V4_ADDITIVE_SQL` with one v4
foundation ledger row; fresh and migrated v4 stores converge to one
byte-identical manifest. The triggers fire only on defects or privileged
tampering (code checks refuse first, typed and zero-write); an actor able to
drop them is outside the protection claim (`CE-STORAGE-IMMUTABILITY-V2`
unchanged).


### Timestamp validation boundary (CE-0002-B3-P2C-A-R1)

The detach transition is the only write path that can set `detached_at`,
and schema v4 enforces the accepted canonical representation on it, not
only the one-way revision transition:

- **SQLite enforces**, on the `participant_session_detach_once` UPDATE path
  only: `detached_at` is a canonical UTC instant: GLOB shape
  (`YYYY-MM-DDTHH:MM:SS.mmmZ`), a `strftime` parse round trip (so month 13,
  February 30, non-leap February 29, day 00, minute 60, and leap seconds
  are refused rather than silently normalized), and hour < 24 (SQLite's own
  date parser accepts `24:00:00`; the accepted representation does not) —
  and `bound_at` is canonical too, with `detached_at >= bound_at` compared
  as text (safe: fixed-width canonical UTC instants order chronologically
  as text). NULL and the empty string are refused, and a STRICT TEXT column
  cannot hold BLOB, so no wrong storage class can reach the predicate as
  anything but non-matching text.
- **The application parser enforces** (`session-state.ts`): the same
  canonicality on every row read: shape, `Date.parse` finiteness, and an
  `toISOString` round trip for `bound_at` and `detached_at`: plus the
  identity patterns and the two-state revision matrix. It remains the
  authority: the insert trigger checks only born-ATTACHED, so a privileged
  writer can still insert a malformed `bound_at`; such a row is refused as
  `STORAGE_OWNERSHIP_CORRUPT` on every read, and the detach path refuses it
  fail-closed.

**Trust boundary.** The triggers protect only while they exist and run. A
connection with `recursive_triggers` disabled bypasses the delete trigger
through conflict-resolution (`INSERT OR REPLACE`) deletes; the storage
connection asserts `recursive_triggers=ON` (with `foreign_keys=ON` and
`trusted_schema=OFF`) on every open. An actor with unrestricted database
write access can drop the triggers or rewrite rows directly: no protection
is claimed against that (`CE-STORAGE-IMMUTABILITY-V2`, unchanged).

### Version recognition and migration

- Normal open requires v4; v1, v2, and v3 stores refuse
  `STORAGE_MIGRATION_REQUIRED` with zero writes. A v4 store carries
  `user_version` 4, so every older binary (supported maximum 3) refuses it
  with `STORAGE_SCHEMA_TOO_NEW`.
- Approved explicit paths: single steps 1→2, 2→3, 3→4 and chains 1→3, 2→4,
  1→4. Each step is one owned IMMEDIATE transaction and commits
  independently; an interrupted step rolls back to a valid store at the
  previous version, and the remaining step can be retried. Intermediate
  targets (v2, v3) are proven by a shape-validated proof open.
- The v3→v4 step re-validates the existing trust root (never creates,
  rotates, or deletes the secret), preserves every Session, ownership,
  fencing, and capability row untouched, and refuses (`STORAGE_CORRUPT`, zero
  writes, never repaired) any pre-v4 Session row that is not exactly ATTACHED
  r1, or any ownership row referencing a detached Session. For v2 and v3
  sources this precondition also runs on the disposable preflight snapshot,
  so a chain refuses before any step commits; it is re-checked on the live
  writer inside the v4 step.

### Session lifecycle validation and read

ATTACHED (NULL, r1) and DETACHED (canonical instant ≥ `bound_at`, r2) are the
only valid Session rows; anything else is `STORAGE_OWNERSHIP_CORRUPT`
wherever a Session row is read, including capability issuance. A DETACHED
Session is never a current binding (`SESSION_NOT_BOUND`), never receives a
new Session-bound capability, and can never be the target of acquisition or
takeover. `readSessionLifecycle` is the private host-local, zero-write,
single-snapshot read (`ATTACHED` / `DETACHED` / `NOT_FOUND`); it is not
re-exported and its refusals use the fixed sanitized details.

### Regression coverage

`test/storage/session-lifecycle.test.ts`: fresh v4 shape, every trigger
(including standalone identity enforcement), Session-ID reuse refusal,
current-Owner detach guard (live, expired, after supersession), ownership
referencing a detached Session, detached-Session refusals across every
operation, malformed-state matrix with privacy and zero-write assertions,
restart persistence, the lifecycle read, v3→v4 / v2→v4 / v1→v4 migrations,
interruption and per-step atomicity, trust-root continuity, zero-write
preflight refusal of foreign lifecycle state, and manifest convergence.
CE-0002-B3-P2C-A-R1 adds the trigger-level timestamp matrix: NULL, empty,
wrong storage class, malformed, noncanonical, and calendar-invalid
`detached_at` values, `detached_at` earlier than `bound_at`, and detach
over a malformed `bound_at` are all refused by SQLite itself, with the
application-level refusals still pinned.

CE-0002-B3-P2C-B adds the authorized detach surface:
`test/storage/detach-lifecycle.test.ts` (authorization matrix incl. forged /
expired / revoked / wrong-scope / wrong-Session capabilities; the full
ownership-interaction matrix incl. no-ownership, released, superseded,
active / expired / legacy / clock-regressed current Owner, clock regression
before `bound_at`, corrupt ownership, and serialized concurrent
release / takeover / renew / detach outcomes; capability lifecycle pins incl.
`SESSION_DETACHED` host-local status, opaque caller refusals, no bulk
revocation, and revocation-refuses-like-expiry; and the
`reconcileDetach` COMMITTED / NO_TRACE / EVIDENCE_CONFLICT matrix);
`test/storage/detach-crash.test.ts` (real OS-process SIGKILL at the
before-commit and after-commit boundaries, with durable forensics and
fail-closed reconciliation: rollback → NO_TRACE + fresh-attempt success,
commit → COMMITTED + terminal retry refusal); and the lock-wait scenarios
F and G in `test/storage/lease-lock-wait.test.ts` (real processes, real
writer lock: a detach serialized after lease expiry still refuses
`SESSION_IS_CURRENT_OWNER` zero-write, and a non-Owner detach serialized
after the lock wait commits at the serialization instant without touching
ownership or fencing).

## B3-P3A: Session-authorized durable send/read (CE-0002-B3-P3A)

Status: **implemented as a private storage slice**. Schema v4 and the frozen
public `Message` entity are unchanged. This amendment does not define endpoint
delivery, ACK, workers, retries, reconciliation, Pi runtime integration, or a
public payload-listing API. The broader P3 delivery scope remains outstanding.

### Preserved B2 creation

`createMessage` remains the accepted trusted-host operation: existing callers
do not acquire a Session requirement and retain the same request digest,
Exchange-scoped idempotency, replay-before-new-write admission, atomic
Message/idempotency/audit triple, audit ordering, payload handling, and
BUSY/ROLLED_BACK/INDETERMINATE classifications. P3A reuses its extracted
transaction-scoped persistence helper; it does not rebuild the Message store.

### Authorized send

`sendMessage` is private storage authority. It captures and validates the
request before `BEGIN IMMEDIATE`, then samples one authoritative instant after
the writer lock is held. In that same transaction it validates, in order: the
exact Session-bound `send` capability and ATTACHED lifecycle; current durable
Owner; presented monotonic fencing token; active persisted lease; Exchange
membership; and the sender Participant's immutable `(adapter, endpointId)`
binding. A Session ID or caller label is never authority.

All checks above precede protected idempotency replay. An authorized historical
replay remains zero-write even after Exchange close; a new Message then applies
the accepted OPEN/no-disposition admission. New persistence atomically commits
the Message, its idempotency record, and one `message_created` audit event.
No result escapes before COMMIT. There is no blind retry after an INDETERMINATE
outcome and no exactly-once or remote-duplicate-prevention claim.

### Protected recipient metadata read

`readMessageMetadata` is a repeatable private operation serialized under the
same writer lock. It requires the exact Session-bound `read` capability, an
ATTACHED current Owner with active lease and current fencing, durable membership,
the requested Exchange identity, and a stable endpoint binding matching the
stored recipient. Missing and wrong-recipient identities share the same opaque
eligibility refusal. It returns only the frozen `Message` metadata plus a private
`auditSequence`; payload bytes never leave this API.

Eligibility is `message_created.sequence > exchange_membership.join_boundary_seq`.
The correlated audit row must be unique and exactly match the Message identity,
Exchange, creation instant, payload digest, and length; missing, duplicate, or
inconsistent correlation fails closed as durable corruption. Audit sequence is
a private projection and is not a new `Message.seq` property.

### Cursor and remaining delivery scope

P3A never inserts or updates `delivery_cursor`. Sending, replaying, reading,
refusing, rolling back, contending, crashing, and recovering therefore fabricate
no ACK progress. `ack` remains `CAPABILITY_SCOPE_UNSUPPORTED`. ACK/cursor
advancement, endpoint delivery, workers, automatic retry, remote duplicate
prevention, delivery reconciliation, and takeover-recovery API redesign remain
outside this amendment.

### P3A evidence

`test/storage/message-send-read.test.ts` pins authority-before-replay, B2
preservation, exact capability/Session/Participant/Owner/lease/fencing checks,
membership and endpoint binding, close/replay admission, recipient-only and
join-boundary visibility, exact audit correlation, rollback, BUSY,
INDETERMINATE fresh-store inspection, metadata privacy, and cursor non-mutation.
`test/storage/message-send-concurrency.test.ts` uses independent OS processes
for same-key sends and send-versus-release/takeover serialization.
`test/storage/message-send-crash.test.ts` uses real SIGKILL at after-BEGIN,
after-Message, after-idempotency, after-audit, and after-COMMIT boundaries and
proves only a complete transaction survives.

## B3-P3C: Minimal Audit correlation index (CE-ARCH-P3C-INDEX-001)

Schema v5 appends exactly one non-unique index:
`idx_audit_event_correlation ON audit_event(exchange_id, kind, subject_id)`.
Every Schema v1-v4 SQL string, object name, and checksum remains frozen. The
index accelerates the existing exact P3A correlation predicate without asserting
uniqueness or changing Message, Audit Sequence, membership, endpoint, capability,
Session, lease, fencing, or ACK semantics.

Fresh initialization writes the v5 foundation ledger and exact v5 manifest.
Existing v4 stores require the explicit approved `4→5` migration; normal open
never migrates. Historical approved paths through v4 remain available but stop at
the exact v4 shape. The v5 step re-validates the host trust root, creates the
index, appends the v5 ledger row, and advances `user_version` in one owned
`BEGIN IMMEDIATE` transaction. A failure proven to have rolled back before commit
returns the store to exact v4. An indeterminate commit outcome does not establish
whether the store is v4 or v5: the operator must inspect the durable store shape
before any retry, and must never retry blindly. A preexisting same-name index is
schema drift and refuses; the migration does not use `IF NOT EXISTS`, repair, or
downgrade.

P3A exact-correlation validation retains every existing check and now reads at
most two matching rows. Zero rows, two rows, or more than two rows all remain
durable corruption; the sole row must still match Exchange, Message subject,
creation instant, digest, length, event schema, outcome, and private revision.
The index cannot prove existence, uniqueness, field agreement, or absence of
orphan rows. The Schema v5 amendment itself added no Inbox API; the separate
bounded private operation below uses that frozen schema without changing it.

## B3-P3C: Bounded storage Inbox Discovery

Status: **implemented as a private storage slice**. The implementation
adds no schema object, migration, table, index, persistent cursor, public package
export, provider integration, background poller, retry loop, ACK behavior, delivery
cursor behavior, or Completion Authority.

### Private operation and authority

`discoverInboxMessages` in `src/storage/inbox-discovery.ts` reuses the exact
Session-bound `read` capability and the existing serialized `BEGIN IMMEDIATE`
transaction boundary. Before reading protected metadata it validates request shape,
capability and Exchange/Participant/Session binding, ATTACHED lifecycle, current
ownership, current fencing token, active lease, Exchange membership, and the
Participant's immutable endpoint binding. Refusals retain the existing sanitized
error taxonomy, and transaction BUSY/ROLLED_BACK/INDETERMINATE classifications are
unchanged.

### Bounded Audit-first enumeration

The operation computes `max(afterAuditSequence, joinBoundarySeq)` and reads at most
`rawScanLimit` Audit rows for the Exchange using `sequence > ? ORDER BY sequence
ASC LIMIT ?`. It never uses Message sequence, timestamps, `OFFSET`, or `K+1`. The
private implementation limits are 50 eligible Messages and 2,000 raw Audit rows;
callers may request smaller positive safe-integer limits only, and `pageSize` may
not exceed `rawScanLimit`. These are implementation parameters, not frozen protocol
constants.

Each `message_created` candidate loads only Message metadata; never `payload_body`—
then invokes the unchanged Schema v5 exact-correlation lookup with `LIMIT 2`. That
validator still requires exactly one matching Audit and validates Exchange, subject,
event kind/schema, Audit Sequence, creation instant, digest, length, revision, and
outcome. Every examined raw row must use the recognized protocol or private membership
Audit vocabulary and valid identity/sequence fields. An observed missing Message,
duplicate correlation, malformed metadata or stable Participant endpoint binding, or
field mismatch fails the whole operation without returning partial metadata. Valid
Messages are filtered against the authorized Participant's stable recipient endpoint.

The result is frozen `{ messages, continuationAuditSequence,
scanBudgetExhausted }`. A non-null continuation is exactly the last raw Audit
Sequence actually examined, including filtered events. It is null when no raw row
was examined. Reaching the eligible-message limit stops immediately without
advancing past unexamined rows. `scanBudgetExhausted` is true only when the complete
raw budget was examined and does not assert that another eligible Message exists.
The continuation is stateless caller input on a later request; it is never persisted
or interpreted as ACK progress.

### Integrity limitation and evidence

Audit-first discovery cannot find a Message that has no `message_created` Audit row,
so an empty bounded result is not proof of global database integrity and the operation
does not claim to detect every orphaned Message. This is deliberate: observable
corruption in an inspected `message_created` candidate fails closed, while unreferenced
Message rows remain outside the bounded Audit window.

`test/storage/inbox-discovery.test.ts` covers authority, pagination, recipient and
Exchange filtering, join boundaries, scan limits, corruption, privacy, zero writes,
BUSY and INDETERMINATE classification, restart behavior, and query plans.
`test/storage/inbox-discovery-concurrency.test.ts` uses independent OS processes to
prove send/list, revocation/list, and release/list valid before-or-after outcomes, plus
a deterministically held Inbox transaction that excludes an overlapping sender.

## B3-P4C: Schema v6 independent payload capability

Status: **implemented for schema and capability authority only**. This phase adds
no payload-read Storage operation, Session Host issuance, Pi tool, delivery behavior,
ACK, cursor mutation, receipt, consumption state, takeover, or Completion Authority.

### Schema v6

Schema v6 changes only the closed `participant_capability.scope` vocabulary by
adding `payload_read`. Every Schema v1-v5 SQL string and checksum remains frozen.
The explicit v5→v6 migration creates `participant_capability_v6`, copies every
column and row, verifies equal counts plus bidirectional `EXCEPT` equivalence, drops
the v5 table, and renames the replacement. The same owned `BEGIN IMMEDIATE` step
then requires an empty `PRAGMA foreign_key_check`, appends the checksummed v6
migration ledger row, and advances `user_version` to 6. Any proven failure rolls
the whole v6 step back to a valid v5 Store; an indeterminate outcome requires
durable shape inspection and is never retried automatically.

Fresh v6 initialization applies the unchanged v5 foundation followed by the exact
same v6 rebuild SQL. Fresh and migrated Stores therefore converge on one strict
approved manifest. Normal Store open accepts only v6 and returns
`STORAGE_MIGRATION_REQUIRED` for recognized v1-v5 Stores; migration remains an
explicit operator action. Approved chains from every v1-v5 source to v6 execute
historical steps in order, with one transaction and commit boundary per step.

### Independent `payload_read` authority

`payload_read` is a new P4C operational, Session-bound scope. The historical P3A
scope list remains exactly `send` and `read`; `read` remains metadata-only and
cannot authorize payload disclosure. Capability HMAC derivation includes the exact
scope, so `read` and `payload_read` tokens are cryptographically non-interchangeable.

Issuance requires the same existing durable ATTACHED Session binding as other
Session-bound scopes. Participant binding, Session binding, trust generation,
revocation, expiry, and DETACHED lifecycle invalidation are inherited unchanged.
The shared current-Owner authorization primitive accepts `payload_read` as an exact
future operation scope, preserving its ownership, fencing, and active-lease checks.
No component automatically issues this capability in this phase, and no plaintext
bearer token is persisted, logged, or exposed through a public DTO.

Evidence is pinned by `test/storage/schema-v6.test.ts` and
`test/storage/payload-read-capability.test.ts`, plus the unchanged migration, Store,
capability, messaging, Inbox, ownership, and recovery regression suites.

## B3-P4D: Authorized Message payload read

Status: **implemented across Storage, the Pi session host, and the operator-opted-in
Pi extension tool**. Schema v6, the `payload_read` capability, and every frozen
contract from B3-P4C are unchanged; this amendment adds no schema object,
capability scope, ACK, cursor, receipt, delivery lifecycle, or Completion
Authority semantics.

### Private Storage operation

`readMessagePayload` in `src/storage/messaging.ts` takes the same request shape
as the metadata read and the same owned `BEGIN IMMEDIATE` serialization. Inside one
transaction it authorizes the exact `payload_read` scope (never the metadata
`read` scope, and vice versa), the ATTACHED Session, current Owner, current fencing
token, and active lease; then Exchange membership, Message metadata, the opaque
missing/wrong-recipient refusal, the recipient endpoint binding, the exact
`message_created` audit correlation, and the recipient's join boundary: all
metadata-only. Only after that chain passes does `readMessagePayloadBodyInTransaction`
in `src/storage/creation.ts` materialize `payload_body`, validate the BLOB type,
exact byte length, and SHA-256 digest against the authorized metadata, and return
a fresh complete byte copy after commit. The operation is a pure read: repeated
authorized reads return identical bytes and no Message, Audit, receipt, cursor,
lease, ownership, or capability state ever changes. `DELIVERY_UNKNOWN` stays
`DELIVERY_UNKNOWN`.

### Session host and Pi extension

`CeSessionHost.readPayload` keeps the raw Store and the plaintext capability
inside the host/storage boundary. The `payloadRead.enabled` operator policy —
exact boolean `true` only; missing, false, or malformed fails closed: is fixed
for the lifetime of a host instance, gates capability issuance in `beginSession`
and validated `resume` alike, and answers a fixed sanitized
`CE_HOST_PAYLOAD_DISABLED` when disabled. The fixed exposure limit is 65,536
encoded bytes, checked before decoding (`CE_HOST_PAYLOAD_TOO_LARGE`), and decoding
is strict UTF-8 (`CE_HOST_PAYLOAD_INVALID_UTF8`); nothing partial ever escapes.

The extension registers `ce_read_payload` (input: `messageId` only) only when the
opt-in is enabled: a disabled deployment registers no payload tool at all. Every
invocation reads the guarded current Pi context, resolves the allowlist, checks the
startup binding, and delegates synchronously. A successful result is a fixed
untrusted-content warning plus the exact decoded text; the payload never appears
in details, logs, failures, or mappings, and no automatic ACK, consumption, polling,
injection, or takeover exists.

Evidence: `test/storage/message-payload-read.test.ts`,
`test/endpoints/pi/session-host-payload.test.ts`, and
`test/endpoints/pi/extension-payload.test.ts`.
