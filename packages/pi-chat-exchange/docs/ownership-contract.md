# B3-P2 Ownership Contract

Status: **clarified by CE-0002-B3-P2A-R1** (this document is the versioned
record of the P2 ownership design decisions). Scope: the private durable
storage plane only. No delivery, adapter, or Pi runtime surface is defined
here.

## Provenance

P2A shipped without an accepted B3-D0 design record in the repository; the
independent review (CE-0002-B3-P2A-INDEPENDENT-REVIEW-1) found the lease time
model unsafe (MAJOR-1) and five undecided design questions (Q1–Q5). R1 records
the decisions below. Each entry distinguishes **accepted existing behavior**
(from B2/P1A/P1B/P2A as implemented and reviewed) from the **newly clarified
decision** that governs from R1 onward.

## Q1 — Owner replacement is takeover

**Decision (new):** Replacing *any* existing Owner — including one whose lease
has expired — belongs to the P2B `takeover` scope. `attach` may acquire
ownership only when **no ownership row exists** for the Participant.

- An existing live row refuses acquisition with `OWNERSHIP_HELD` (accepted P2A
  behavior, unchanged).
- An existing expired row — including a legacy v2 row, which is expired at
  every instant — refuses acquisition with `OWNERSHIP_TAKEOVER_REQUIRED`
  (new). No fencing token is allocated by a refused acquisition.
- `takeover` remains `CAPABILITY_SCOPE_UNSUPPORTED`; no takeover implementation
  exists in R1.
- Consequence: after a lease expires, the Participant has a durable,
  fenced, non-authorizing ownership record until P2B takeover exists. This is
  deliberate fail-closed behavior, not an oversight.

## Q2 — Resume authority is Session-bound

**Decision (new):** `resume` authority must ultimately be Session-bound. R1
implements the minimum safe foundation:

- Schema v3 adds `participant_capability.session_id` (nullable; NULL for all
  non-resume scopes and for legacy v2 rows).
- Issuing a `resume` capability requires `sessionId`, and the Session must be
  currently bound to the Participant at issuance (checked in the same
  transaction). `sessionId` is refused for every other scope.
- Every `resume` authorization compares the durable binding with the presented
  Session inside the mutation's transaction; a legacy unbound row, a missing
  presentation, or a mismatch classifies `SESSION_MISMATCH` and refuses.
- Revoking a `resume` capability requires presenting its bound Session.
- **Non-goal:** the Session ID is not a credential. No operation is authorized
  by a Session ID alone; the bearer token, Participant binding, scope, trust
  generation, revocation, and expiry checks are all unchanged.

P2A's Participant-wide resume tokens do not survive: on a migrated store, a
legacy (NULL) resume capability can never authorize. The host issues new
Session-bound resume capabilities. Fail closed, no silent widening.

## Q3 — Lease term boundaries are durably persisted

**Decision (new):** the lease term start is persisted
(`participant_ownership.lease_started_at`), written at acquisition and updated
at every renewal. Default TTL 120 s; allowed TTL 30–3600 s (unchanged from
P2A).

- Lease evaluation compares the operation clock against the persisted
  boundaries `[leaseStartedAt, expiresAt)` only. A request TTL is used solely
  to compute a *new* expiry at acquisition or renewal; it never reinterprets a
  stored term. (This remediates R1-finding MAJOR-1: the P2A model derived the
  term start as `expiresAt − requestTTL`, which falsely refused valid Owners
  when TTLs differed between calls and allowed a rolled-back clock to extend a
  lease by widening the presented TTL.)
- Renewal never shortens the term: a new expiry earlier than the current one
  is refused (`LEASE_TERM_SHORTENED`).
- Exact-expiry refusal is preserved: `now >= expiresAt` is `LEASE_EXPIRED`.
- **Known limit (unchanged, documented):** a wall-clock rollback that lands
  *inside* the current term cannot be distinguished from a valid instant
  without a persisted monotonic observation. R1 does not claim detection of
  every rollback. Refusals are zero-write.
- Legacy v2 ownership rows (NULL `lease_started_at`) are treated as expired at
  every instant: no lease start is fabricated from an untrusted TTL, and no v3
  operation authorizes against them.

## Q4 — Expired Owners cannot release

**Decision (confirmed existing P2A behavior, now contractual):** release
requires a live lease. An expired Owner's release refuses `LEASE_EXPIRED`; the
row persists (fenced, non-authorizing) until takeover.

## Q5 — A current Owner's Session binding cannot be deleted directly

**Decision (confirmed existing P2A behavior, now contractual):** P2A/P2A-R1
has no detach operation. A detached Session that is the current Owner is
inconsistent durable state (`STORAGE_OWNERSHIP_CORRUPT`, refused, never
repaired). Detach semantics (including the detach-versus-ownership ordering
rule) are deferred to P2B.

## Accepted existing behavior carried into R1 unchanged

- Session identity: opaque, non-secret `ses_<ULID>`; never a Participant
  identity, never a credential. A Session belongs to exactly one Participant
  (now also enforced by the durable `participant_session_unique_session_id`
  index); a Participant may hold many historical Sessions. Binding never
  confers ownership; Participant creation never creates Sessions or ownership.
- Fencing: first token 1; strictly monotonic high-water per Participant;
  survives restart, expiry, and release; never reused; allocation past
  `Number.MAX_SAFE_INTEGER` refuses (`FENCING_EXHAUSTED`); fencing and the
  ownership write are one atomic unit; an ownership row must carry exactly the
  current high-water token and a bound Session or the state is corrupt.
- Capability plane: bearer tokens, host-keyed digests, trust-generation
  binding, revocation, expiry; one opaque `CAPABILITY_REJECTED`
  classification; trust root re-validated per authorization.
- Transaction discipline: owned BEGIN IMMEDIATE transactions; BUSY /
  ROLLED_BACK / INDETERMINATE classification; refusal over repair; zero-write
  refusals; privacy boundaries (fixed sanitized details).

## P2B prerequisites recorded by R1

1. Takeover: replace an existing (expired or legacy) Owner under a `takeover`
   capability, allocating the next fencing token and a fresh term; classify
   and pin the takeover races. **Implemented by CE-0002-B3-P2B** — see below.
2. Detach: define the ordering rule — a current Owner's binding cannot be
   detached while the ownership row references it (Q5) — and the fate of
   Session-bound resume capabilities at detach.
3. Lease policy location: if TTL policy must outlive a single request (e.g. a
   store-fixed policy), decide whether it belongs in durable metadata.

## P2B — Takeover implemented (CE-0002-B3-P2B)

Status: **implemented**. The Q1 decision is realized without changing any R1
boundary: `acquireOwnership` still refuses every existing row; replacement is
exclusively `takeoverOwnership` under the `takeover` scope.

- **Authority.** The `takeover` scope is operational and Session-bound to the
  prospective new Owner Session, consistent with the accepted resume model
  (Q2): issuance requires `sessionId` naming a currently bound Session of the
  Participant, classification compares the durable binding inside the
  mutation's transaction, and revocation requires presenting the bound
  Session. A Session ID alone never grants takeover authority. `send`, `ack`,
  and `read` remain inactive.
- **Eligibility.** Only an existing EXPIRED row — including a legacy v2 row
  (NULL `lease_started_at`, expired at every instant) — may be taken over. A
  live Owner refuses (`OWNERSHIP_HELD`, evaluated against the persisted term;
  exact expiry is the boundary), a clock-regressed lease refuses
  (`LEASE_CLOCK_REGRESSION`), and an absent row refuses
  (`OWNERSHIP_TAKEOVER_INELIGIBLE`): initial acquisition remains the `attach`
  operation. No force takeover of a live Owner exists in this phase.
- **Atomicity.** Eligibility, fencing allocation (exactly high-water + 1,
  compare-and-set, `FENCING_EXHAUSTED` at the ceiling), and the Owner
  replacement are one owned IMMEDIATE transaction guarded by the exact
  pre-read values: exactly one winner, no partial fencing allocation, no
  partial replacement, no token reuse, zero-write refusals. A takeover racing
  a renewal of a live lease can never win (the lease is live at every instant
  of the race).
- **Supersession.** The previous Session immediately loses current ownership:
  its fencing token is stale and its `resume` capability cannot renew,
  release, or verify the new Owner (`OWNERSHIP_NOT_CURRENT` /
  `FENCING_STALE`). Historical Session bindings, Participant identity,
  Endpoint binding, Exchange membership, join boundaries, and audit history
  are untouched; capability rows are never mutated by a takeover.
- **Recovery.** `reconcileTakeover` is a zero-write, fail-closed
  reconciliation read over the evidence the caller presents (Participant,
  target Session, the exact persisted term boundaries, optional fencing
  token): `COMMITTED` (exact durable match — do not retry), `NO_TRACE` (the
  durable state carries no trace of the presented evidence — a fresh attempt
  is freshly authorized and eligibility-checked), or `EVIDENCE_CONFLICT` (the
  target Session is current under different evidence — operator review, never
  auto-retry). All three are effect-level classifications of durable state,
  never operation-level attribution of one invocation: `COMMITTED` is not an
  exactly-once claim, and `NO_TRACE` is not proof that the original invocation
  never committed (a committed takeover later superseded also reports
  `NO_TRACE`). Documented limitations, deliberately not papered over with
  exactly-once semantics: a refused and a rolled-back takeover leave identical
  durable state; a committed-then-superseded takeover reports `NO_TRACE`; a
  committed retry with identical parameters is the same logical request. No
  background recovery workers.
- **Evidence availability (clarified, no behavior change).** The operation
  clock is sampled inside the owned transaction (see B3-P2B-R1 below), so the
  sampled instant is not an ordinary caller-supplied request field:
  `leaseStartedAt` is that sample and `expiresAt` is `sample + ttl`. The exact
  term normally reaches the caller only through a successful return, or when
  the caller itself supplies and records the operation clock seam; a
  default-clock caller whose call ended INDETERMINATE does not know it, and
  pre-call wall-clock sampling does not reconstruct it. `reconcileTakeover`
  currently requires `participantId`, `sessionId`, `leaseStartedAt`, and
  `expiresAt`, with `fencingToken` optional, and callers must not fabricate,
  estimate, or round term boundaries to satisfy that shape. INDETERMINATE is
  not ROLLED_BACK: the invalidated connection must not be reused, inspection
  requires a freshly opened store, and a lost acknowledgement never authorizes
  a blind retry. When exact term evidence is unavailable the outcome simply
  stays unknown to the caller — there is no UNKNOWN input and no UNKNOWN
  disposition in the API. A pre-call `readFencingHighWater` snapshot that is
  unchanged on a later valid read of the same Participant shows that no
  fencing allocation committed for that Participant between the two reads; an
  increased high-water identifies no invocation, proves nothing about this
  caller's takeover, and never establishes a durable lease. The operator-only
  recovery caller resolving CE-TAKEOVER-RECOVERY-CALLER-001 deliberately does
  not call `reconcileTakeover`: before writing it requires exact endpoint and
  old-owner evidence and an expired durable lease; it then binds a fresh
  recovery Session, uses the existing Session-bound `takeover` primitive,
  releases that lease, and detaches the recovery Session. A successful caller
  returns a capability-free receipt plus durable fencing/session evidence. Any
  INDETERMINATE stage remains unknown and is never retried automatically.
  `reconcileTakeover` still has no production caller because a default-clock
  caller cannot reconstruct exact term boundaries after losing acknowledgement
  (CE-TAKEOVER-RECONCILIATION-EVIDENCE-001). Full statement:
  `docs/storage-contract.md` §11 "Evidence availability after an uncertain
  outcome".
- **Legacy ownership.** A migrated v2 row never authorizes and is never
  repaired; it is takeover-eligible, and takeover replaces it with a fully
  persisted v3 term at a fencing token strictly greater than the legacy token.
- Q4 and Q5 are unchanged: an expired Owner cannot release, and there is no
  detach operation (P2B did not take detach; it remains prerequisite 2).


## B3-P2B-R1 — transaction-time clock sampling (remediation)

Status: **implemented**. Remediates the independently confirmed MAJOR-1 of
CE-0002-B3-P2B-INDEPENDENT-REVIEW-1 (stale pre-lock clock).

**The defect.** P2B sampled each operation's clock *before* `BEGIN
IMMEDIATE`. An operation that waited for the SQLite writer lock evaluated
authorization and lease state against the pre-lock instant: a renewal
initiated before expiry but serialized after it committed from the stale
sample, reviving an expired lease and locking out a legitimately eligible
takeover (reproduced by the reviewer with real processes and real lock
contention). A capability that expired during the lock wait was likewise
accepted.

**The decision (new, contractual):** every owned mutating transaction has
exactly one authoritative operation-time sampling point — *inside* the owned
transaction, after `BEGIN IMMEDIATE` has acquired the writer lock:
`BEGIN IMMEDIATE → sample now → validate authority → evaluate current state
→ mutate → COMMIT`. All checks within one mutation use this one consistent
instant. This applies to `bindSession`, `acquireOwnership`, `renewLease`,
`releaseOwnership`, `verifyOwnership`, `takeoverOwnership` (ownership plane)
and to `createParticipant` (sponsor authorization), `bindEndpointRef`,
`issueCapability`, `revokeCapability`, and `joinExchange` (capability/membership
plane). Lease start and expiry derive from the transaction-time clock;
capability expiry is evaluated at the transaction-time clock, so a capability
that expired during a lock wait can never be accepted. Request validation
(field shape, TTL range, identities) still precedes the transaction and
performs no state-dependent check.

**Preserved semantics.** Exact-expiry behavior is unchanged (`now >=
expiresAt` is expired); clock-regression refusal is unchanged (a pre-term
instant refuses `LEASE_CLOCK_REGRESSION`); the injected-clock test seam is
unchanged (it is simply invoked at the transaction-time sampling point); no
scheduler and no global clock is introduced. Audit of the remaining storage
mutation entry points (corrected by CE-0002-B3-P2C-A): B2 Exchange/Message
creation samples its clock during candidate generation, *before* `BEGIN
IMMEDIATE`; its timestamps are recorded creation metadata that authorize
nothing, so the accepted B2 contract is unchanged (its invalid-clock behavior
remains the accepted precedent). Migration/recovery/initialization
`appliedAt` ledger timestamps likewise authorize nothing and are unchanged.

**Lock-wait semantics (now defined).** Authorization and eligibility are
decided at the serialization instant, not the initiation instant. A renewal
initiated before expiry but serialized after it refuses `LEASE_EXPIRED`; a
takeover initiated before expiry but serialized after it is eligible and may
win; a takeover serialized while the lease is still live refuses
`OWNERSHIP_HELD`; a capability that expired during the wait refuses
`CAPABILITY_REJECTED`. Every such refusal is zero-write and never allocates
a fencing token.

**Remaining wall-clock limitations (unchanged, no new monotonicity claim).**
A wall-clock rollback that lands *inside* the current term remains
indistinguishable from a valid instant without a persisted monotonic
observation (Q3); transaction-time sampling decides each operation at its
own serialization instant and does not create a cross-transaction monotonic
clock. Refusals remain zero-write.

**Regression pins.** `test/storage/lease-lock-wait.test.ts` exercises the
renewal/takeover/capability lock-wait boundaries with real OS processes, a
real writer lock, observable initiation markers, and deadline waits against
durable expiries (no sleep-only assertions, no fake-clock simulation of
contention).
## P2C prerequisites recorded by P2B

1. Detach semantics (Q5 ordering rule and the fate of Session-bound
   capabilities at detach).
2. Lease policy location (prerequisite 3 above, unchanged).
3. `send`/`ack`/`read` scopes remain for the delivery phases.

## B3-P2C-A — Irreversible Session lifecycle and schema v4 (CE-0002-B3-P2C-A)

Status: **implemented** (structural foundation only). Realizes the accepted
CE-0002-B3-P2C-D0 design decisions D1, D2, D5 (as a schema guard), D9 (read),
D14, and D15. **No detach operation exists yet**; capability scope semantics
are unchanged (no `detach` scope; `resume` is not yet widened to
self-detach). P3 is not started.

- **States.** A Session row is exactly ATTACHED (`detached_at IS NULL`,
  `private_revision = 1`) or DETACHED (canonical `detached_at` not earlier
  than `bound_at`, `private_revision = 2`). Every other combination is
  `STORAGE_OWNERSHIP_CORRUPT`: refused, zero-write, never repaired. DETACHED
  is terminal; a detached Session is never a current binding and never
  regains authority.
- **Schema v4 (triggers only).** Session rows are born ATTACHED, never
  deleted, and keep immutable Participant ID, Session ID, and `bound_at`; the
  only permitted UPDATE is the one-way ATTACHED r1 → DETACHED r2 transition;
  the current Owner Session cannot be detached; an ownership row can never
  reference a detached Session. Session IDs are therefore never reused. No
  table rebuild, no new column, no new capability scope.
  R1: the transition also requires a canonical `detached_at` no earlier than
  a canonical `bound_at`, enforced by SQLite itself — see
  `docs/storage-contract.md` §12 for the exact SQLite-versus-application
  validation boundary, the `recursive_triggers` requirement, and the
  privileged-writer trust limits.
- **Ownership interaction (Q5 formalized).** The current Owner — live,
  expired, legacy, or clock-regressed — cannot be detached while the
  ownership row references it; the way out is the existing release or
  takeover. Detach never deletes or replaces ownership and never touches the
  fencing high-water.
- **Validation.** `issueCapability` (Session-bound scopes), `bindSession`,
  `acquireOwnership`, `takeoverOwnership`, `renewLease`, `releaseOwnership`,
  `verifyOwnership`, and every Session read strictly validate the row: a
  DETACHED Session refuses `SESSION_NOT_BOUND`; a malformed row refuses
  `STORAGE_OWNERSHIP_CORRUPT`; re-binding a detached Session ID refuses as
  before (`SESSION_ALREADY_BOUND` / `SESSION_BOUND_TO_OTHER_PARTICIPANT`).
- **Lifecycle read.** `readSessionLifecycle` is a private, host-local,
  zero-write read over one snapshot returning `ATTACHED` / `DETACHED` /
  `NOT_FOUND` (a foreign pair is `NOT_FOUND`); it validates the
  Participant's ownership state in the same snapshot and authorizes nothing.
- **Remaining P2C work (P2C-B): implemented** by CE-0002-B3-P2C-B — see the
  next section. P3 (send/ack/read, delivery) is not started.

## B3-P2C-B — Authorized Session Detach (CE-0002-B3-P2C-B)

Status: **implemented**. Realizes the accepted P2C-D0 design decisions D4,
D7, D10, and D11 without changing any accepted boundary: schema v4 stays
frozen (no DDL, no new migration, no checksum change), no `detach` capability
scope exists, and Disconnect is not Detach — Detach is a durable binding
lifecycle fact of the private storage plane, never a transport event.

- **Operation (D4).** `detachSession(store, request)` performs the one-way
  ATTACHED → DETACHED transition under the Session's own Session-bound
  `resume` capability — self only. The capability must authorize exactly its
  bound Session; a Session ID alone is never a credential. Inside one owned
  BEGIN IMMEDIATE transaction, in order: transaction-time clock (sampled
  after the writer lock is acquired), capability validation (trust
  generation, expiry, revocation, Session binding), Participant identity,
  Session binding, complete ownership-state validation, the
  current-Owner refusal, the clock-regression refusal, and the guarded
  `detached_at IS NULL AND private_revision = 1` → `detached_at = now,`
  `private_revision = 2` update with exactly one changed row.
- **Ownership interaction (Q5).** The current Owner — live, expired, legacy
  (NULL `lease_started_at`), or clock-regressed — refuses
  `SESSION_IS_CURRENT_OWNER` while the ownership row references its Session,
  regardless of lease expiry. The way out is the existing release (live
  Owners only; Q4 preserved: an expired Owner cannot release) or an
  authorized takeover, after which the superseded former Owner detaches
  freely. Detach never modifies the ownership row, never touches the fencing
  high-water, never deletes the Session row, and never mutates capability
  rows. Concurrent release / takeover / renew outcomes are derived from the
  serialized durable state; the real-process lock-wait scenarios F and G pin
  the serialized boundaries.
- **Capability lifecycle (D7).** Session lifecycle validation is centralized
  in capability classification: a Session-bound capability whose bound
  Session is DETACHED is unusable for every presenter. The persisted
  `detached_at` is the lifecycle source of truth — read-time invalidation
  only, no bulk revocation, no capability-row rewrites. Caller-visible
  refusals remain the one opaque `CAPABILITY_REJECTED`; the host-local
  status read identifies `SESSION_DETACHED`. The future Session-bound
  scopes (`send`, `ack`, `read` — not implemented in this phase) inherit the
  check unchanged when they join `SESSION_BOUND_CAPABILITY_SCOPES`. A
  Session-bound capability whose binding row is missing or malformed refuses
  `STORAGE_OWNERSHIP_CORRUPT` — never adopted, never repaired. Deliberate
  error-precedence change (documented, pinned): for a DETACHED Session, the
  capability-plane refusal now outranks the operation-level
  `SESSION_NOT_BOUND` that `renewLease` / `releaseOwnership` /
  `verifyOwnership` / `takeoverOwnership` previously surfaced; `attach`
  (not Session-bound) still refuses `SESSION_NOT_BOUND` at the operation.
  Revoking a detached Session's capability refuses exactly like revoking an
  expired one.
- **Recovery.** `reconcileDetach(store, evidence)` is the private, read-based,
  zero-write, fail-closed reconciliation after an uncertain outcome (failure
  before or after COMMIT, lost response, BUSY, ROLLED_BACK, INDETERMINATE):
  COMMITTED / NO_TRACE / EVIDENCE_CONFLICT classified from the durable
  Session state in one snapshot, with ownership coherence validated in the
  same snapshot (concurrent takeovers and releases are simply part of the
  observed state). The evidence `detachedAt` is optional: with it, an exact
  match is COMMITTED and any mismatch is EVIDENCE_CONFLICT (operator
  review); without it, a DETACHED row is COMMITTED because the terminal
  durable effect exists. The durable effect is idempotent; the API response
  is not — a retry of a committed detach refuses `CAPABILITY_REJECTED` — so
  the discipline is reconcile first, never blindly retry, and a fresh
  attempt after NO_TRACE is a new full authorization, not a replay. No
  exactly-once execution is claimed. `reconcileTakeover` is unchanged.
- **Lease policy (D10/D11).** The host owns lease policy: default TTL 120 s,
  accepted range 30–3600 s, renewal recommendation 30 s. An adapter may
  REQUEST a TTL per operation (`leaseTtlSeconds`); the request only computes
  the new expiry at acquisition or renewal and never reinterprets a stored
  term. No policy is persisted — there is no policy table and none is
  planned for this phase. Hosts should schedule renewal well before expiry
  using the `expiresAt` returned by acquisition and renewal (and re-derive
  the schedule from each renewal's returned `expiresAt`), because an
  operation serialized after expiry refuses `LEASE_EXPIRED` and cannot
  revive the term; the persisted `lease_started_at` / `expires_at` boundaries
  always decide.

## B3-P3A — Scoped current-Owner authority

Status: **implemented for private storage send/read only**. The historical P2
sections above remain the record of their phase boundaries; where they say
`send`/`read` were inactive, this P3A amendment supersedes that status.

`send` and `read` are now operational and are Session-bound exactly like
`resume`/`takeover`: issuance requires a durable ATTACHED Session binding,
classification binds Participant + exact scope + trust generation + Session,
revocation presents that Session, and terminal detach makes the token unusable
without rewriting capability rows. `ack` remains inactive.

The shared current-Owner primitive defaults to `resume` for all accepted P2
renew/release/verification callers, preserving their API and refusal precedence.
P3A callers explicitly request only `send` or `read`; neither a resume token nor
a takeover token authorizes those operations. Inside the caller-owned IMMEDIATE
transaction, capability classification precedes Participant/Session checks, then
the durable ownership row establishes the current Owner, the presented fencing
token must equal the persisted monotonic token/high-water state, and the
persisted lease term must be active without clock regression.

P3A samples authority time only after the writer lock is acquired. A send racing
release serializes either before release and may commit, or after release and
refuses `OWNERSHIP_NOT_CURRENT`. A near-expiry send racing takeover similarly
commits only before replacement or refuses as the former Owner afterward; it
cannot commit under stale fencing. Independent-process tests pin both outcomes.

This amendment does not broaden takeover recovery, define Pi Session lifecycle
outside the existing durable binding, or grant authority from a Session ID,
Participant ID, Worker/Advisor label, endpoint label, or fencing token alone.
ACK and external delivery remain outstanding P3 work.
