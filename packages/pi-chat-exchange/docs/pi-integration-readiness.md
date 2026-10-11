# Pi Runtime Integration Readiness — CE-0002 B3-P3B

Status: **implemented as a minimal local slice** (host adapter + Pi extension).
Verified against `@earendil-works/pi-coding-agent 0.86.1` (installed) and the
B3-P3A authorized send/read storage slice. No external delivery, no ACK, no
inbox discovery.

## Architecture

```
Pi process A                          Pi process B
┌─────────────────────┐              ┌─────────────────────┐
│ .pi extension       │              │ .pi extension       │
│  (lifecycle, tools) │              │  (lifecycle, tools) │
│        │            │              │        │            │
│ CeSessionHost (A)   │              │ CeSessionHost (B)   │
│  memory-only tokens │              │  memory-only tokens │
└────────┼────────────┘              └────────┼────────────┘
         │                                   │
         └──────────┬────────────────────────┘
                    ▼
        shared durable SQLite store (schema v4)
        host trust-root secret (uid-owned, mode 600)
```

- `src/endpoints/pi/session-host.ts` is the only host-side composition layer.
  It imports no Pi SDK types; plain data in, plain data out.
- `.pi/extensions/ce-chat-exchange/index.ts` is the Pi runtime adapter. It
  holds no credentials itself; all authority is delegated to the host seam.
- Chat Exchange owns Participant/Session/message authority. Pi owns the
  runtime and SessionManager. Wayforge retains Completion Authority. No
  authority is transferred between these systems.

## Identity mapping

| Identity | Source | Stability |
|---|---|---|
| Pi session id | `pi --session-id` (uuidv7 otherwise) | operator-controlled label; changes on `/new`, `/fork`; stable across `/reload` |
| CE Participant | host-provisioned, immutable `(adapter, endpointId)` binding | durable forever |
| CE Session | host-generated `ses_…` at provisioning | durable; ATTACHED until terminal detach |

The Pi session id is a **lookup key into the operator allowlist only**. It is
never a CE Session id and never a credential. A forked or new Pi session has a
new id; unless the operator adds it to the allowlist it resolves to no
endpoint and the extension stays inert (fail closed).

Persisted mapping (`pi.appendEntry("ce-mapping", …)`) carries exactly
`{endpointId, participantId, sessionId, exchangeId}` — identifiers only. On
`startup` / `reload` / `resume` the host validates it against durable state
(Participant binding match, Session ATTACHED, ownership row current, lease
active) before re-issuing Session-bound capabilities. A stale, foreign,
detached, or unowned mapping refuses with `CE_HOST_MAPPING_INVALID` or
`CE_HOST_AUTHORITY_ABSENT`; nothing is repaired or adopted implicitly.

## Four visibility states (do not conflate)

1. **Stored** — `sendMessage` committed Message + idempotency + audit.
2. **Extension-visible** — `readMessageMetadata` returned metadata to the
   recipient's host. Requires an explicitly supplied `messageId`.
3. **Conversation-visible** — only if the receiving extension injects text
   into its own session (e.g. `pi.sendMessage`). SQLite writes never appear
   in a Pi conversation by themselves.
4. **Model-consumed** — only when the injected entry participates in a turn.

The B3-P3B slice implements states 1 and 2. State 3 is available through the
documented owning-session seam but is intentionally not wired automatically;
state 4 follows from normal Pi context handling.

## Failure model

| Case | Behavior |
|---|---|
| Pi restart within lease | `resume` re-issues capabilities from validated mapping identifiers |
| Pi restart after lease expiry | `CE_HOST_AUTHORITY_ABSENT`; operator reauthorization required; no takeover recovery (`CE-TAKEOVER-RECOVERY-CALLER-001`) |
| `/reload` | same Pi session id; mapping re-adopted after validation; stale captured contexts are rejected by the runtime |
| `/new` / `/fork` | inherited `ce-mapping` entries ignored; fresh provisioning only if the new Pi id is allowlisted |
| Capability expiry/revocation | `CAPABILITY_REJECTED` surfaces as sanitized refusal; re-issue requires host policy |
| Detached CE Session | terminal; mapping refuses; new binding required |
| SQLite BUSY | whole request rolled back; `CE_HOST_BUSY` (retryable) |
| INDETERMINATE | `CE_HOST_UNCERTAIN`; reopen and inspect durable state before any retry; never a blind retry |
| Duplicate send | Exchange-scoped idempotency replays the original result; one durable Message |

## Host trust boundary

- The operator allowlist is the only registration authority; model/tool
  arguments cannot register Participants, issue capabilities, or change
  ownership.
- Capability plaintext is memory-only: never logged, never persisted in Pi
  session entries, never present in tool results or model-visible context.
- The host trust-root secret is read only by the storage plane inside its own
  owned transactions.
- No second credential authority, no second SessionManager, no generic
  credential broker.

## Validation map

- Adapter unit tests: `test/endpoints/pi/session-host.test.ts`.
- P3A authority chain: `test/storage/message-send-read.test.ts`,
  `message-send-concurrency.test.ts`, `message-send-crash.test.ts`.
- Real two-process runtime smoke: `docs/plans/2026-10-11-pi-integration-slice.md`.
