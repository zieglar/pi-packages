# pi-handoff Protocol v1 (frozen)

Frozen 2026-10-05 by PH-0001 Phase 0/1. Changes require an explicit contract
revision. Machine-readable forms of these contracts live in `src/protocol/`.

## 1. Identity

- Authoritative handoff identity: `ho_<ULID>` (Crockford Base32 ULID,
  26 chars, 48-bit ms timestamp + 80-bit CSPRNG randomness).
  Properties: opaque, unique, immutable, non-secret, independent of prompt
  contents, safe to persist and log.
- Result identity: `hr_<ULID>` (same construction, distinct prefix).
- Display IDs (e.g. last 8 chars) are convenience labels only; they are never
  authoritative for persistence, correlation, or API identity.

## 2. Lifecycle state machine

```text
CREATED → QUEUED → CLAIMED → DELIVERED → ACKNOWLEDGED → RUNNING → SETTLED
                                                              ↘ (no activity
                                                                observed) ↗
SETTLED → RESULT_AVAILABLE → CONSUMED
```

Failure / cancellation / ambiguity states, modeled explicitly:

```text
QUEUED   → CANCELLED
CLAIMED  → CANCELLED        (consumer releases before delivery)
CLAIMED  → QUEUED           (lease expiry, delivery DEFINITELY not attempted)
DELIVERED → DELIVERY_UNKNOWN (acknowledgement unknown)
DELIVERY_UNKNOWN → ACKNOWLEDGED  (confirmed accepted by runtime probe)
DELIVERY_UNKNOWN → FAILED        (confirmed not executed)
DELIVERY_UNKNOWN → CANCELLED     (owner abandons)
any failure path → FAILED
```

Terminal states: `CONSUMED`, `CANCELLED`, `FAILED`.
Quarantined state: `DELIVERY_UNKNOWN` (neither terminal nor retryable).

### Frozen semantics

| State | Means | Does NOT mean |
| --- | --- | --- |
| QUEUED | broker durably accepted the handoff | that Pi received it |
| CLAIMED | a Pi-side consumer acquired processing ownership | delivery or execution |
| DELIVERED | delivery to the Pi runtime attempted/committed per the Pi API boundary | that Pi accepted it |
| ACKNOWLEDGED | Pi accepted the prompt/request | that execution succeeded |
| RUNNING | meaningful runtime activity observed | semantic correctness |
| SETTLED | the runtime invocation settled | that the task is correct |
| RESULT_AVAILABLE | a result envelope is durably available | that anyone read it |
| CONSUMED | ChatGPT/client explicitly retrieved or acknowledged the result | — |

**Ambiguous delivery fails closed.** `DELIVERY_UNKNOWN` has no transition to
`QUEUED`, `CLAIMED`, or `DELIVERED`, and there is no automatic retry from it:
a duplicated coding prompt may cause irreversible repository changes.
Resolution requires explicit, evidence-backed transition to `ACKNOWLEDGED`,
`FAILED`, or `CANCELLED`. Safe requeue (`CLAIMED → QUEUED`) is allowed only
when the delivery record proves no attempt was made (lease expiry).

## 3. Idempotency (create)

`handoff_create` accepts an optional `idempotencyKey` (1–256 chars), scoped to
the owning namespace, stored with a canonical-request digest (SHA-256 over
recursively key-sorted JSON):

```
create(key=A, digest=D) → ho_123
create(key=A, digest=D) → ho_123   (same record)
create(key=A, digest=E) → IDEMPOTENCY_KEY_CONFLICT   (never a new id)
```

Reference implementation: `InMemoryIdempotencyStore` in
`src/protocol/idempotency.ts`. The durable broker must preserve identical
semantics transactionally.

## 4. ChatGPT MCP surface (tools frozen; only `ping` implemented in Phase 1)

| Tool | Kind | Purpose |
| --- | --- | --- |
| `ping` | read-only | liveness probe (implemented) |
| `handoff_create` | write | create a handoff (prompt, optional idempotencyKey/workspace/metadata) → handoff record |
| `handoff_get` | read | fetch one handoff by id (state + digests, never raw prompt in list views) |
| `handoff_list` | read | list handoffs filtered by state/createdAt window, bounded page size |
| `handoff_cancel` | write | request cancellation; legal from QUEUED/CLAIMED/DELIVERY_UNKNOWN only |
| `handoff_result` | read | fetch the result envelope for a handoff |

There is deliberately **no** ChatGPT-facing `submit_result`,
`mark_completed`, `acknowledge_delivery`, or equivalent. Those capabilities
exist only on the internal consumer surface (§5). All write tools must carry
accurate MCP annotations; ChatGPT imposes confirmation on tools without
`readOnlyHint: true`.

Schemas: `HandoffCreateRequestSchema`, `HandoffSchema`,
`HandoffResultSchema` in `src/protocol/`.

## 5. Pi consumer surface (internal only — never MCP tools)

Operations: `claim_next`, `acknowledge`, `heartbeat`, `report_activity`,
`settle`, `publish_result`, `release`.

- The broker offers these exclusively to authenticated local consumers (the
  pi-handoff Pi extension).
- Transport recommendation (frozen, deferred): **loopback HTTP** —
  `http://127.0.0.1:<ephemeral-port>` with a per-install bearer token stored
  in a `0600` file next to the broker state (`~/.local/share/pi-handoff/`).
  Smallest robust mechanism that stays portable across macOS/Linux/Windows;
  a Unix domain socket is the approved future optimization where both ends
  support it. Loopback bind must reject non-loopback interfaces; payloads are
  size-bounded.
- RPC mode is explicitly rejected for this surface (it would create a
  competing Pi session).

## 6. Result envelope

Distinguishes three layers, never collapsed (`HandoffResultSchema`):

```text
HandoffResult {
  handoffId            ho_<ULID>
  resultId             hr_<ULID>
  attempt              integer ≥ 1
  startedAt, settledAt ISO-8601 UTC
  transportOutcome     "delivered" | "delivery_unknown"
  runtimeOutcome       "succeeded" | "failed" | "cancelled" | "interrupted"
  result { summary, body }
  source { piSessionRef, workspace }
  inputDigest          sha256(canonical prompt payload)
  resultDigest         sha256(canonical result payload)
  applicationEvidence? opaque — pi-handoff does not interpret it
}
```

A future Wayforge integration may put `taskState` /
`completionEvidenceDigest` inside `applicationEvidence`; pi-handoff persists
and forwards it opaquely and never treats it as semantic correctness.

## 7. Security rules (frozen)

- Never persist or expose: ChatGPT credentials, Pi OAuth credentials, API
  keys, raw auth files, environment secrets, hidden model reasoning, raw
  provider error bodies (unless explicitly sanitized).
- Prompt/result bodies are expected payload data: persisted with restrictive
  permissions, excluded from diagnostic logs; diagnostics use IDs, digests,
  lengths, and typed status.
- ChatGPT-facing responses never echo credentials or environment values; the
  Phase 1 `ping` exposes only `platform + release`.
