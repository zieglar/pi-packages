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
  v1 manifest): refused with `STORAGE_MIGRATION_REQUIRED` — migration is
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
mode 0600, current-user-owned, no symlinks — the same artifact enforcement
the database itself passes. Only its SHA-256 fingerprint is persisted, in the
append-only `host_trust_root` table. Every v2 open re-reads the file, repeats
the artifact checks, and compares the fingerprint: missing file
`STORAGE_TRUST_ROOT_MISSING`, disagreement `STORAGE_TRUST_ROOT_MISMATCH`,
insecure artifact `STORAGE_TRUST_ROOT_INSECURE`, preexisting secret during
initialization/migration/recovery `STORAGE_TRUST_ROOT_AMBIGUOUS` — all fail
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
`participant_session` stays unused in P1B. `instanceId` is ephemeral — it is
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
IDs never authorize anything. Revocation is explicit and one-way; there is no
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
Nothing is added to the public package surface — the private storage boundary
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
disagreement is `STORAGE_TRUST_ROOT_MISMATCH` — typed trust-root refusals, as
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
Participant with no current Owner — no ownership row, or only an expired
one. A live lease, including one held by the requesting Session itself, is
`OWNERSHIP_HELD`: no silent adoption, no takeover. Acquisition allocates the
fencing token and writes the ownership row in one owned transaction.

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
After supersession every operation by the previous Owner is refused.

Default TTL 120 s, configurable 30–3600 s (request-validated). 30 s is a
renewal recommendation for hosts, not a scheduler. Time comes only from the
injected clock. A lease authorizes only within `[expiresAt - ttl, expiresAt)`:
renewal sets `now + ttl`, so a rolled-back clock before the current term
start is refused and can never extend a lease. Release removes only the
ownership row.

**Limitation:** the accepted schema has no lease-start column, so the term
start is derived from the host TTL policy, which must stay consistent for a
lease's lifetime. A rollback that lands inside the current term cannot be
distinguished from a valid instant without a persisted monotonic observation
(refusals are zero-write).

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
