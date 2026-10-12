# Pi Runtime Integration Readiness — CE-0002 B3-P3D

Status: **explicit bounded Inbox integration implemented**, extending the B3-P3B
host adapter and Extension. Prior Pi 0.86.1 runtime evidence belongs to B3-P3B;
the new `ce_inbox_list` has real-Store Host tests and an isolated fake Pi API harness.
Real two-process Inbox dogfood remains a separate NOT_RUN acceptance phase.
No external delivery, ACK, automatic consumption, injection, or polling is added.

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
        shared durable SQLite store (schema v6)
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
2. **Extension-visible** — explicit `ce_inbox_list` discovers eligible IDs, and
   `ce_read` returns metadata only. With operator opt-in, `ce_read_payload`
   separately returns Storage-authorized UTF-8 text for an explicit ID.
3. **Conversation-visible** — successful explicit tool results enter the
   invoking Pi conversation through normal tool handling. SQLite writes never
   appear there by themselves; this extension does not inject user messages.
4. **Model-visible** — the successful payload tool content is available to the
   active model through normal Pi context handling. Visibility alone does not
   prove semantic consumption, delivery settlement, or Completion Authority.

B3-P3B and B3-P3D provide metadata operations. B3-P4D adds opt-in explicit
payload exposure: at most 65,536 encoded bytes, complete fatal UTF-8 decoding
with a leading BOM preserved. Payload text appears only in successful tool
content, not details or mappings, and may enter durable Pi conversation history.
No automatic reading, polling, ACK, cursor advance, consumption, injection,
lease renewal, or ownership takeover is wired.

## Explicit Inbox integration

`CeSessionHost.listInbox` composes the existing memory authority, current fencing
preflight and private `discoverInboxMessages` operation. Storage revalidates exact
Session-bound read capability, ATTACHED state, ownership, fencing, active lease,
membership and immutable endpoint binding inside the existing transaction.
The Extension gets no raw Store and implements no duplicate CE authorization.

At each invocation, `ce_inbox_list` accesses guarded `ctx.sessionManager`, looks up
the Pi Session's allowlisted endpoint and compares it with the successful startup
binding. No await separates that check from the synchronous Host invocation.
Shutdown and every new startup invalidate the Inbox binding; stale contexts refuse.

Inputs are only `afterAuditSequence`, `pageSize`, `rawScanLimit`; defaults are
0/50/2000 with safe integers, bounds 1..50 and 1..2000, and effective P <= K.
Unknown/authority-bearing fields refuse. Output projects only Message IDs and Audit
Sequences, plus unchanged `continuationAuditSequence` and `scanBudgetExhausted`.
A non-null continuation is the last examined raw Audit (including filtered events),
not ACK state. The caller explicitly requests another page; no cursor is persisted.
An empty page is not global integrity proof, and missing creation Audits are outside
Audit-first discovery. Budget exhaustion does not assert another eligible Message.

Refusals reuse existing sanitized Host codes/reasons/retryable flags. No unreliable
`CeHostRefusal.outcome`, raw causes or stacks are exposed. BUSY may be retried only
explicitly; INDETERMINATE requires operator reopening/inspection before any retry.

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
- Extension registration/context harness: `test/endpoints/pi/extension-inbox.test.ts`.
- Bounded Storage discovery: `test/storage/inbox-discovery.test.ts`,
  `test/storage/inbox-discovery-concurrency.test.ts`.
- P3A authority chain: `test/storage/message-send-read.test.ts`,
  `message-send-concurrency.test.ts`, `message-send-crash.test.ts`.
- Real two-process runtime smoke: `docs/plans/2026-10-11-pi-integration-slice.md`.
- P4D authorized payload read: `test/storage/message-payload-read.test.ts`,
  `test/endpoints/pi/session-host-payload.test.ts`,
  `test/endpoints/pi/extension-payload.test.ts` (extension harness; no real
  Pi dogfood claimed).
- New Inbox dogfood procedure (not executed in B3-P3D implementation):
  `.pi/extensions/ce-chat-exchange/README.md`, isolated two-process acceptance.
