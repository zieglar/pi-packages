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
   and pin the takeover races.
2. Detach: define the ordering rule — a current Owner's binding cannot be
   detached while the ownership row references it (Q5) — and the fate of
   Session-bound resume capabilities at detach.
3. Lease policy location: if TTL policy must outlive a single request (e.g. a
   store-fixed policy), decide whether it belongs in durable metadata.
