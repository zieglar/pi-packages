# pi-chat-exchange Architecture (PH-0002, frozen 2026-10-06)

One private package, four layers, one dependency direction:

```text
src/bin        composition only (stdio entrypoint)
src/adapters   mcp (ping smoke only) | pi (contract documentation only)
src/core       pure rules + in-memory idempotency REFERENCE
src/protocol   neutral data contracts (schemas, lifecycle tables, ports)
```

Arrows point at dependencies: `bin -> adapters -> core -> protocol`, and
adapters may use protocol directly. Protocol never reaches core or adapters;
core never reaches adapters; the two adapters never reach each other.
`scripts/check-contract.mjs` enforces this transitively (barrels included)
from the TypeScript AST — import/export declarations, dynamic `import()`, and
`require()` — not from regexes, and negative fixtures in `scripts/fixtures/`
prove the gate rejects violations.

## Aggregate and lifecycles

- **Exchange** is the aggregate root: `OPEN` governs correlation and message
  creation; `CLOSED` is an explicit owner action. Reads never close anything
  ("no read == done" is forbidden).
- **Message** is an independent entity with its own lifecycle:
  `CREATED → QUEUED → CLAIMED → DISPATCHING → ACCEPTED → RUNNING → SETTLED →
  RESULT_AVAILABLE`, plus `DELIVERY_UNKNOWN` (quarantine), `CANCEL_REQUESTED`,
  and the finished states `CANCELLED`/`FAILED`. There is **no CONSUMED**:
  reading a result is a non-mutating observation.
- **DeliveryAttempt** carries the durable dispatch evidence; **Result** is an
  independent immutable entity (publish-once, exact replay or conflict);
  **Receipt/Consumer/Lease/Event** are supporting contracts.

## Evidence rules (core/rules.ts)

- Entering `DISPATCHING` requires an attempt whose dispatch-start marker was
  durably recorded BEFORE any adapter side effect.
- Any potentially attempted dispatch that cannot be confirmed quarantines as
  `DELIVERY_UNKNOWN`: no transition back to retryable states, no automatic
  retry. Resolution requires correlated evidence plus explicit
  reconciliation authority — never an expired consumer lease.
- `CLAIMED → QUEUED` (safe requeue) requires a validated
  definitely-not-attempted attempt record: evidence, not assertion.
- Guards correlate message, attempt and endpoint. Live progress and safe
  release/requeue also compare the recorded lease to the authoritative latest
  claim (`currentLease`), not just a caller's historical matching token.
  Quarantine may be recorded after expiry; it never licenses re-dispatch.
- Runtime acceptance/progress/settlement require independent correlated
  `RuntimeEvidence`; result availability requires a published correlated Result.
  Transport delivery alone is not runtime acceptance. Cancellation cannot
  erase ambiguity.
- Host transactions must load trusted authoritative snapshots and the complete
  message set, authenticate callers and commit atomically. Pure helpers do not
  implement durable storage, authentication, current-claim allocation or CAS.
- Cancellation splits request (`CANCEL_REQUESTED`, client) from confirmation
  (agent evidence, or owner reconciliation for quarantined messages).
- `closeExchange` is client-authority only and requires every message of the
  exchange to be finished: nothing in flight, nothing quarantined, no pending
  cancellation.

## Ports

Narrow, disjoint, literal-typed data contracts (no inheritance framework):
`ClientPort` (send/get/list/cancel/result; explicit close is a separate
OPTIONAL capability, not implemented) and `AgentPort` (claim, dispatch-start,
delivery/activity/settlement reporting, result publication, lease release,
ambiguity resolution, cancellation confirmation). Compile-negative tests in
`test/types/` guard the shapes at typecheck time; runtime authority is
enforced by the core rules — compile-time checks are never an authorization
mechanism.

## Scope boundary (frozen)

No broker, storage, API server, loopback HTTP, SQLite, bearer tokens, Pi
polling listeners, `sendUserMessage` automation, results automation, full MCP
API, or install steps in this phase. The MCP adapter exposes strictly the
`ping` smoke; the Pi adapter is contract documentation only. The durable host
is deferred until these contracts are accepted; the old persistence proposal's
concrete choices (SQLite, loopback + bearer token) stay deferred with it.
