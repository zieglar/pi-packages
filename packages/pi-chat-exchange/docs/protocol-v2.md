# pi-chat-exchange Protocol v2 (frozen)

Frozen 2026-10-06 by PH-0002 (the approved architecture correction of
PH-0001). Changes require an explicit contract revision. Machine-readable
forms live in `src/protocol/` (schemas, lifecycle requirement table) and
`src/core/rules.ts` (pure enforcement). See [architecture.md](architecture.md)
for layering and [protocol-v1.md](protocol-v1.md) for the superseded v1.

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
randomness, losslessly encoded — see
[identity-hotfix-ph0002.md](identity-hotfix-ph0002.md)), opaque, unique,
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
`src/protocol/lifecycle.ts`): evidence-free moves are licensed by state shape
alone (`canTransition`); every other move cites an evidence class validated by
core rules (`isLegalTransition` + `assertMessageTransition`). Highlights:

- `CLAIMED → QUEUED` / `CLAIMED → CANCELLED`: agent authority + recorded
  lease + `not_attempted` dispatch evidence (the only safe requeue).
- `CLAIMED → DISPATCHING`: agent authority + **current** lease + durable
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
- `DELIVERY_UNKNOWN → ACCEPTED/FAILED`: agent authority + recorded lease +
  correlated transport evidence + **explicit reconciliation evidence**.
  `DELIVERY_UNKNOWN → CANCELLED`: client (owner) authority + reconciliation.
  No exit to retryable states; no automatic retry anywhere.
- Cancellation: `QUEUED → CANCELLED` (client; nothing dispatched) is the only
  evidence-free cancel. From `CLAIMED/DISPATCHING/ACCEPTED/RUNNING` the
  client may only `→ CANCEL_REQUESTED`; confirmation
  (`CANCEL_REQUESTED → CANCELLED`) needs either provably not-attempted
  dispatch or correlated runtime `cancelled` confirmation; ambiguity remains
  quarantined. Failure/settlement requires its own evidence, not the request.

Guards must correlate the exact message, attempt, endpoint and recorded lease.
For live progress and safe release/requeue, `currentLease` must ALSO match the
authoritative latest claim read by the host transaction (token, consumer,
instance and expiry). An old attempt's matching lease is not enough. Invalid
timestamps fail closed. Quarantine/reconciliation may cite historical leases
but never authorize retry or dispatch.

These helpers validate supplied snapshots, not persistence/authentication.
The future host must authenticate the principal, load the current message,
attempt, latest claim, complete exchange message set and published result itself,
then check-and-commit atomically. Never accept `authority`, `currentLease`, or
published-result proof directly from an external adapter as authoritative.
Concurrent revision/CAS and durable fencing allocation remain unimplemented.
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

## 5. Capability ports (src/protocol/capabilities.ts)

- Client: `exchange_send`, `exchange_get`, `exchange_list`,
  `exchange_cancel` (request), `exchange_result`. `exchange_close` is a
  separate optional capability, declared but not implemented.
- Agent: `message_claim`, `dispatch_mark_started`, `delivery_report`,
  `activity_report`, `settlement_report`, `result_publish`, `lease_release`,
  `ambiguity_resolve`, `cancel_confirm`.
- Disjoint by construction; `assertPortDisjointness` is the frozen invariant.

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
(`test/adapters/mcp/`, service label updated to the project rename).

## 7. Security rules (frozen, carried from v1)

Never persist or expose credentials, API keys, auth files, environment
secrets, or hidden model reasoning. Payload/result bodies are sensitive:
correlate via digests in diagnostics; events carry IDs, digests, lengths, and
typed outcomes only. The MCP surface performs no `process.env` access
(enforced by the package check). Endpoint identity is non-secret by contract.
