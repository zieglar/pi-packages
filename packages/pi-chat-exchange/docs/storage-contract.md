# Durable storage contract (CE-0002-B2-S6-2)

Consolidated contract for the accepted private SQLite durable storage of
Chat Exchange. Every normative claim below is backed by accepted test or
implementation evidence; see the traceability matrix at the end.

Scope labels used throughout:

- **public contract** — behavior callers can rely on;
- **internal** — private implementation detail, not a caller guarantee;
- **test-only** — capability existing only in the test harness;
- **limitation** — known boundary of current evidence;
- **deferred** — recorded future requirement, not implemented.

This document does not change any architecture, production behavior, or test.

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
and length — never payload bytes, and no payload accessor (tests: SB6,
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
is a nonretryable conflict — never a replace (tests: I4, I5; C2 race and
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

All mutations run inside `withImmediateTransaction` — a synchronous,
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
scenario the WAL file is zero bytes at crash time — K5 is an *uncommitted
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

**Non-blocking gap — `CE-PRIVACY-EXCHANGE-ERROR-COVERAGE` (deferred):**
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

- **`CE-STORAGE-IMMUTABILITY-V2`** — Schema v1 lacks authenticated state
  integrity; privileged CLOSED→OPEN drift is characterized but not prevented
  (tests: F4, P4).
- **`CE-STORAGE-WAL-RECOVERY-REGRESSION`** — no committed regression test for
  non-empty committed-WAL crash recovery; evidence is review-harness only.
- **`CE-PRIVACY-EXCHANGE-ERROR-COVERAGE`** — createExchange error paths lack
  direct privacy mutation sensitivity (see §3).

Future product capabilities (not implemented, not designed here):

- **`CE-SESSION-CONTINUITY-001`** — a new Pi Session can safely resume
  participation in an existing Exchange without losing committed messages.
  Current boundary: persisted messages and Store reopening do not by
  themselves provide cross-session continuity; participant takeover is out
  of scope here.
- **`CE-RECONNECT-001`** — recover communication after ChatGPT.app restart,
  update, or temporary disconnection. Distinct layers: persisted Exchange
  state (this contract), Pi-side connection restoration, ChatGPT.app
  integration, and task-execution recovery. ChatGPT.app must not be assumed
  to provide an automatic reconnect lifecycle hook.

B2 scope is not expanded by these entries.

## 6. Traceability matrix

| Contract claim | Test evidence | Accepted commit | Limitation |
| --- | --- | --- | --- |
| Exchange creation: 3 rows, one transaction, audit seq 1 | exchange-creation suite; `creation.ts:120`,`:178` | `deefd8e` | — |
| Message creation: schema-valid CREATED, 3 rows visible | M1, M6 | `deefd8e` | — |
| Public fields incl. endpoints; deep freeze | M3, M5; S6-1 sweep | `deefd8e`, `84e0603` | endpoints are public, not hidden |
| Private payload; digest/length only; no accessor | SB1–SB10, M3, M7–M9 | `deefd8e` | — |
| Idempotent replay: zero writes, metadata preserved | I1–I3, I7 | `deefd8e` | — |
| Conflict nonretryable; no replace | I4, I5, I8, C2 | `deefd8e`, `1250800` | — |
| Admission: missing/CLOSED/dispositioned refused | A1, A3–A8, F2-A/F2-B/F3 | `deefd8e`, `8318b36` | — |
| Transaction outcomes: BUSY/ROLLED_BACK/INDETERMINATE + invalidation | transaction suites; S6-1 error tests | `deefd8e`, `84e0603` | INDETERMINATE ≠ zero-write guarantee |
| Error precedence and corruption refusal | P1–P5 | `5005078`, `a51c091` | — |
| Crash boundaries K1–K6, SIGKILL commit durability | crash suite (19 tests) | `263c191`, `b3141ca` | harness-based process fixtures |
| Lock release, contention, reader isolation | R1-A, R1-B, R2 | `f178dec` | — |
| Close/reopen + concurrent replay | R4, C5 | `bbf28f0`, `1250800` | — |
| K5 uncommitted rollback survives crash | R3 | `bbf28f0` | WAL zero bytes; see CE-STORAGE-WAL-RECOVERY-REGRESSION |
| Public-surface privacy sweep + binary controls | S6-1 suite (18 tests) | `84e0603`, `f606594` | createExchange error paths: CE-PRIVACY-EXCHANGE-ERROR-COVERAGE |
| Private storage boundary / no public export | architecture contract gate (19 fixtures) | (workspace gates) | — |
