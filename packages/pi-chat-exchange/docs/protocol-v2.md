[English](protocol-v2.md) | [简体中文](protocol-v2.zh-CN.md)

# pi-chat-exchange Protocol v2 (frozen)

> Historical protocol-phase record: descriptions of unimplemented hosts,
> persistence, and endpoints below refer to PH-0002/PH-0003. For later private
> storage and MCP implementations, see [storage-contract.md](storage-contract.md)
> and [delivery-ack-contract.md](delivery-ack-contract.md). Frozen protocol
> semantics remain unchanged.

Frozen 2026-10-06 by PH-0002 (the approved architecture correction of
PH-0001). Changes require an explicit contract revision. Machine-readable
forms live in `src/protocol/` (schemas, lifecycle requirement table) and
`src/core/rules.ts` (pure enforcement). See [architecture.md](architecture.md)
for layering; the superseded v1 is recorded in `docs/protocol-v1.md` (repo-only,
not distributed).

**Authorized PH-0003 amendment:** the owner-abandonment cancellation exception
is superseded by the amendment recorded in `docs/quarantine-hotfix-ph0003.md`
(repo-only, not distributed). The amended rule itself is stated in this contract.
No identity format, outcome vocabulary or normal close precondition changes.

**Approved PH-0003 convergence:** Client/Agent labels become scoped action grants;
MCP is a control surface, not conversation delivery. Peer endpoint support is
independent of authorization and factual evidence. Entity/identity schemas and
the corrected lifecycle edges remain unchanged. The underlying audit is recorded
in `docs/chat-bridge-audit-ph0003.md` (repo-only, not distributed).

## 1. Identity (compatibility preserved)

| Entity | Prefix | Status |
| --- | --- | --- |
| Exchange | `ho_<ULID>` | legacy v1 prefix retained (v1 "handoff" → Exchange aggregate); no id migration |
| Result | `hr_<ULID>` | unchanged from v1 |
| Message | `msg_<ULID>` | additive v2 |
| DeliveryAttempt | `att_<ULID>` | additive v2 |
| Receipt | `rcpt_<ULID>` | additive v2 |
| Event | `evt_<ULID>` | additive v2 |

All ids: Crockford Base32 ULID (48-bit ms timestamp + 80-bit CSPRNG
randomness, losslessly encoded — derivation recorded in
`docs/identity-hotfix-ph0002.md`, repo-only, not distributed), opaque, unique,
immutable, non-secret, independent of payload contents. Display suffixes are
never authoritative.

## 2. Message lifecycle

```text
CREATED → QUEUED → CLAIMED → DISPATCHING → ACCEPTED → RUNNING → SETTLED
                                                             → RESULT_AVAILABLE
```

Auxiliary states: `DELIVERY_UNKNOWN` (quarantined), `CANCEL_REQUESTED`, and
finished `CANCELLED` / `FAILED` (with `RESULT_AVAILABLE`). There is no
`CONSUMED`: reads never mutate lifecycle state.

Transition legality is a two-tier table (`TRANSITION_REQUIREMENTS` in
`src/protocol/lifecycle.ts`): shape-only helpers (`canTransition`,
`isLegalTransition`) answer structural legality, never authorize mutations.
Every actual transition checks scoped grants; evidence-bearing moves additionally
check their correlated factual evidence. Highlights:

- `CLAIMED → QUEUED` / `CLAIMED → CANCELLED`: scoped release/confirm grant + recorded
  lease + a consistent `not_attempted` / `pending` attempt (the only safe
  requeue). Contradictory transport facts cannot be laundered by the marker.
- `CLAIMED → DISPATCHING`: scoped dispatch-start grant + **current** lease + durable
  `started` dispatch marker (marked BEFORE any adapter effect).
- `DISPATCHING → ACCEPTED`: current authoritative fenced lease + transport
  `delivered` **and independently correlated runtime `accepted` evidence**.
  Transport delivery alone is never runtime acceptance.
- `DISPATCHING / CLAIMED / CANCEL_REQUESTED → DELIVERY_UNKNOWN`: recorded
  attempt + potentially attempted/ambiguous transport evidence; lease expiry
  does not prevent recovery into quarantine. These recovery records do not
  grant live dispatch authority.
- `DISPATCHING → FAILED`: current lease + transport `failed`, reported only
  when the adapter proves no side effect occurred; otherwise `ambiguous`.
  A crash after the start marker quarantines via `CLAIMED → DELIVERY_UNKNOWN`.
- Runtime progress requires current fencing and independently correlated
  `RuntimeEvidence` (`exchangeId`, `messageId`, `attemptId`, endpoint, outcome,
  observation time): `RUNNING` needs `running`; `SETTLED` needs settlement-grade
  `settled|runtime_error|cancelled|interrupted`. A dispatch marker is not proof
  of execution. `SETTLED → RESULT_AVAILABLE` additionally requires a validated
  correlated immutable Result loaded from successful publication.
- `DELIVERY_UNKNOWN → ACCEPTED/FAILED`: scoped reconciliation grant + recorded lease +
  correlated transport evidence + **explicit reconciliation evidence**. Acceptance
  additionally requires an independent scoped runtime-progress grant and evidence.
  `DELIVERY_UNKNOWN → CANCELLED` is prohibited (PH-0003 authorized hotfix):
  owner intent/reconciliation text is not execution evidence. Administrative
  abandonment is a separate disposition, never an execution-state transition.
  No exit to retryable states; no automatic retry anywhere.
- Cancellation: `QUEUED → CANCELLED` (cancellation-request grant; nothing dispatched)
  is evidence-free but NOT permission-free. From `CLAIMED/DISPATCHING/ACCEPTED/RUNNING`
  the requester may only `→ CANCEL_REQUESTED`; confirmation requires a separately
  scoped cancellation-confirmation grant.
  (`CANCEL_REQUESTED → CANCELLED`) needs either provably not-attempted
  dispatch (`not_attempted` plus `pending`) or a started/delivered attempt with
  correlated runtime `cancelled` confirmation; ambiguity remains quarantined.
  Started runtime cancellation ALSO requires settlement-report authority;
  no-attempt cancellation does not synthesize a runtime event.
  Failure/settlement requires its own evidence, not the request. Queued
  cancellation also rejects contradictory presented dispatch evidence.

Guards must correlate the exact message, attempt, endpoint and recorded lease.
For live progress and safe release/requeue, `currentLease` must ALSO match the
authoritative latest claim read by the host transaction (token, consumer,
instance and expiry). An old attempt's matching lease is not enough. Invalid
timestamps fail closed. Quarantine/reconciliation may cite historical leases
but never authorize retry or dispatch.

These helpers validate supplied snapshots, not persistence/authentication.
The future host must authenticate the principal, load the current message,
attempt, latest claim, complete exchange message set and published result itself,
then check-and-commit atomically. Never accept `authorization`, `currentLease`, or
published-result proof directly from an external adapter as authoritative.
Concurrent revision/CAS and durable fencing allocation remain unimplemented.
Request-only moves need no synthetic lease input. Attempt-backed moves still
require validated recorded/current lease evidence according to the unchanged
transition table.

## 3. Entities (src/protocol/entities.ts)

- `Exchange { exchangeId, state OPEN|CLOSED, createdAt, closedAt? }`
- `Message { messageId, exchangeId, from, to, state, payloadDigest,
  payloadLength, createdAt, idempotencyKey? }` — either direction; no
  product fields survive schema validation.
- `EndpointRef { adapter, endpointId, instanceId? }` — opaque non-secret
  routing identity; durable endpoint vs ephemeral instance; no free routing
  metadata, no credentials (`additionalProperties: false`).
- `Lease { consumerId, instanceId, fencingToken ≥ 1, expiresAt }`
- `DeliveryAttempt { attemptId, messageId, endpoint, lease, dispatch
  not_attempted|started, transport pending|delivered|ambiguous|failed,
  createdAt }`
- `RuntimeEvidence { exchangeId, messageId, attemptId, endpoint, outcome,
  observedAt }` — independent runtime observation, never inferred from transport.
- `Result { resultId, exchangeId, messageId, attemptId, source, transport,
  runtime, body, resultDigest, settledAt, applicationEvidence? }` —
  transport trichotomy `delivered|ambiguous|failed`; runtime ladder
  `accepted|running|settled|runtime_error|cancelled|interrupted`;
  `applicationEvidence` is opaque JSON the protocol never interprets.
- `Receipt { receiptId, exchangeId, messageId, endpoint, kind
  read|delivery_ack|duplicate_suppressed, createdAt }`
- `Consumer { consumerId, label?, createdAt, lastSeenAt? }`
- `Event { eventId, exchangeId, sequence ≥ 1, kind, subjectId, createdAt,
  digest?, length?, outcome? }` — diagnostics carry IDs/digests/lengths/typed
  outcomes only; raw payload bodies are structurally rejected.

### Administrative termination without execution resolution

Normal `Exchange.state = CLOSED` still requires every Message to be finished.
It is not broadened to mean an unresolved Exchange was cancelled or succeeded.
Instead an immutable `ExchangeDisposition` records administrative termination:

```text
status = ABANDONED_UNRESOLVED
exchangeId, ownerId, recordedAt, reason, reconciliation intent
unresolved[] = { messageId, originalState: DELIVERY_UNKNOWN,
                 transport: ambiguous, unresolvedSideEffects: true,
                 attempt: original started/ambiguous DeliveryAttempt snapshot }
```

The Exchange snapshot remains OPEN and Messages remain DELIVERY_UNKNOWN; the
independent disposition makes the aggregate administratively inactive, not
execution-resolved. A future view/API must expose BOTH execution facts and the
disposition, never translate this marker into CANCELLED, FAILED_NO_EFFECT, a
Result or success. The marker itself is the immutable administrative audit
record. Its owner/time/reason and investigation metadata are not execution proof.
`reconciliation.resolvedAt` retains the existing metadata field name, but here
timestamps the investigation/intent record, not resolution of side effects.

`archiveUnresolvedExchange` requires owner authority, at least one unresolved
Message, exactly one correlated started/ambiguous active attempt per unresolved
Message, and no remaining in-flight activity. Other Messages may already be
finished. It preserves snapshots and permits exact replay, never replacement.
No transport outcome is altered, no retry/requeue is authorized, no Result is
manufactured. Unknown→ACCEPTED/FAILED still requires actual correlated evidence
and explicit reconciliation BEFORE administrative termination.

`assertExchangeActive` is the host admission precondition for creation, claims
and every subsequent protocol mutation. Transition, publication and normal
close helpers also reject a supplied authoritative disposition. The future
host MUST load that record atomically; external callers cannot select/omit it.
Administrative termination does not stop an already-delivered external runtime
or prevent its side effects; it only stops protocol activity. Later external
facts may be retained as separate audit observations, never revive the archived
protocol or rewrite the original uncertainty snapshot. Historical reads remain
non-mutating and allowed. Persistence, ACLs, audit append and APIs are not
implemented in this phase.

## 4. Idempotency (create)

Keyed by **(namespace, key)** with a canonical-request digest (SHA-256 over
recursively key-sorted JSON; unsupported values and cyclic structures are
rejected with `DigestInputError`). Equivalent repeats replay the same
immutable record; same key with a different digest fails closed with
`IDEMPOTENCY_KEY_CONFLICT`. The in-memory reference store
(`src/core/reference.ts`) is a semantics reference only, not durable.
Namespace/key storage uses an unambiguous JSON tuple, not concatenation with
a caller-allowed separator. Opaque application evidence must be finite, acyclic
plain JSON; Maps/Sets/Dates, sparse arrays, symbols and unsupported values are
rejected at core publication/read boundaries. Publication requires a
settlement-grade runtime outcome; reading returns immutable snapshots without
recording semantic completion.

## 5. Action grants and endpoint support

Closed `CONTROL_OPERATIONS`: `exchange_send/get/list/cancel/result`. Optional
`exchange_close` and `exchange_archive` remain separate grants and unimplemented
control APIs. `ENDPOINT_OPERATIONS`: claim, dispatch-start, delivery report,
runtime activity/settlement, publication, lease release, factual reconciliation
and cancellation confirmation. Catalog separation is checked by
`assertOperationSeparation`; it does NOT impose protocol roles.

`AuthorizationContext { principalId, grants[] }`; each grant has
`{ action, principalId, scope }`. Actions and scopes are a closed discriminated
union, validated at typecheck and runtime. Send/get/result require Exchange
scope; cancel requires Message scope; claim requires Message+destination scope;
endpoint mutations require Message+Attempt+recipient scope (all include Exchange).
Close/archive require owner scope and bind ownerId to the context principal.
Listing declares collection permission; future host filtering is still required.
Different principal/Exchange/Message/Attempt/endpoint incarnation cannot reuse
a grant. Delivery authority alone cannot assert runtime acceptance.

**Contexts are not credentials.** The future host authenticates identities,
maps sender/destination/owner/consumer bindings, loads current grants and
authoritative snapshots and supplies contexts to pure core rules transactionally.
Caller-provided grants, adapter kind, implemented interface or support claims
cannot establish any of those facts. No host/authentication service exists here.

`EndpointDeclaration { kind, capabilities }` advertises independent delivery,
observation, cancellation, follow-up and result-production support.
Support is `supported|unsupported|unknown`; optional/missing means unknown.
No method or advertisement creates evidence or grants. Pi declares only a
binding shape; no implemented capabilities are advertised. No ChatGPT endpoint
is implemented. Known delivery with unknown execution cannot be mislabeled
DELIVERY_UNKNOWN or manufacture runtime acceptance/settlement. Unsupported
workflows may be rejected by future admission policy before effects.

## 5a. Result versus conversational reply

Result remains processing evidence/output for one Message/Attempt. Publication
requires its scoped grant, settlement-grade outcome and immutable replay/conflict
validation. The future host must check publication and RESULT_AVAILABLE transition
together against authoritative settled Message/Attempt/runtime facts; the helper
alone is not proof of execution.

Reply/follow-up communication is another Message in the same Exchange, with
its own ID, reversed or otherwise explicit from/to and independent evidence.
No automatic Result-to-Message conversion, reply send, read-consumption or close
exists. This needs no change to Message/Result/EndpointRef wire schemas.

## 6. Superseded v1 semantics (documented)

| v1 (PH-0001) | v2 (PH-0002) | Why |
| --- | --- | --- |
| Handoff entity `ho_` | Exchange aggregate `ho_` (same prefix) | aggregate root correction |
| `CONSUMED` terminal state | removed | reads must never be semantic consumption |
| `DELIVERED` state, `CLAIMED→QUEUED` shape-legal | `DISPATCHING` + evidence-gated requeue | durable dispatch-start before effect; validated no-attempt proof |
| `piSessionRef` source field | generic `EndpointRef` | opaque, product-neutral routing identity |
| `CHATGPT_TOOLS` / consumer surfaces | `CLIENT_OPERATIONS` / `AGENT_OPERATIONS` ports | no product names; disjoint literal authority |
| transport `delivered\|delivery_unknown`; runtime `succeeded\|failed\|…` | transport `delivered\|ambiguous\|failed`; runtime `accepted\|running\|settled\|runtime_error\|…` | generic vocabularies, layers never borrow terms |
| (proposed) loopback HTTP + bearer token broker | deferred with the durable host | out of v2 scope |

Superseded v1 tests: `schemas.test.ts` and `surfaces.test.ts` (removed; their
invariants survive as `entities.test.ts` and `capabilities.test.ts`);
`lifecycle.test.ts` was rewritten for the v2 machine; `idempotency.test.ts`
was extended (namespace scoping, immutable records, strict digest input).
Retained unchanged: the 11 identity/encoder tests
(`identity.test.ts`, hotfix-regression included) and the MCP smoke tests
(`test/control/mcp/`, moved by PH-0003 without smoke behavior changes).

## 7. Security rules (frozen, carried from v1)

Never persist or expose credentials, API keys, auth files, environment
secrets, or hidden model reasoning. Payload/result bodies are sensitive:
correlate via digests in diagnostics; events carry IDs, digests, lengths, and
typed outcomes only. The MCP surface performs no `process.env` access
(enforced by the package check). Endpoint identity is non-secret by contract.
