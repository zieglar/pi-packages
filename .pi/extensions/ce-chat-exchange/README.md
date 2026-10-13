# ce-chat-exchange — CE-0002 B3-P6B explicit tools and Inbox advisory

Local, Session-authorized messaging with explicit bounded Inbox discovery,
opt-in authorized payload reading, and an optional lifecycle-triggered count-only
Inbox advisory. The runtime slice is verified against Pi 0.86.1; Extension
behavior has an isolated harness. Real two-process dogfood is a separate
acceptance phase and is not claimed by these instructions.
## What it does

- On `session_start`, resolves this Pi session's endpoint from the operator
  allowlist, then either recovers the persisted mapping (reasons
  `startup` / `reload` / `resume`) or provisions a fresh CE Session.
- Registers `ce_send`, `ce_read`, `ce_inbox_list`, `/ce-status`, and — only when
  the operator sets `payloadRead.enabled` to the exact boolean `true` — the
  `ce_read_payload` tool.
- When `inboxNotification.enabled` is the exact boolean `true`, performs one
  bounded authorized Inbox check after a successful Session binding and after
  `agent_settled`, then emits count-only advisory UI text when appropriate.
- Persists the mapping (identifiers only) as a `ce-mapping` custom session
  entry via `pi.appendEntry`.
- On `session_shutdown`, drops the in-memory capability row.

## What it deliberately does NOT do

- No ACK, delivery cursor mutation, automatic consumption, timer, background
  polling, automatic page draining, external idle wake, or cross-process signalling.
- No external delivery: writing to SQLite never makes a message visible in
  another Pi conversation. `ce_read` returns metadata only. Payload text
  leaves the storage plane solely through an operator-opted-in
  `ce_read_payload` invocation that Storage fully authorizes first.
- No automatic takeover recovery (`CE-TAKEOVER-RECOVERY-CALLER-001` stays
  unresolved). An expired lease fails closed with `CE_HOST_AUTHORITY_ABSENT`.
- A forked or newly created Pi session never inherits the previous mapping:
  fork/new reasons ignore inherited `ce-mapping` entries entirely.

## Trust boundary

- The **allowlist is the only registration authority**. Pi session ids are
  untrusted lookup labels; they select an endpoint label and authorize
  nothing. Model/tool arguments can never register Participants, issue
  capabilities, or change ownership — they only pick a recipient label,
  message text, an idempotency key, and the explicit message ids (and Inbox
  scan budgets) whose Storage-authorized reads they request.
- Capability plaintext exists only in the host adapter's process memory.
  It is never logged, never persisted in Pi session entries, and never
  present in tool results or model-visible context beyond the fixed refusal
  codes.
- The host trust-root secret is only ever read by the storage plane inside
  its own owned transactions; this extension never touches it.

## Configuration

Copy `allowlist.example.json` to `allowlist.json` (or point `CE_ALLOWLIST`
at a file):

| Field | Meaning |
|---|---|
| `sessions` | map of `pi --session-id` value → operator endpoint label |
| `exchangeNamespace` / `exchangeIdempotencyKey` | deterministic exchange bootstrap |
| `leaseTtlSeconds` | ownership lease (30–3600; default 120) |
| `payloadRead.enabled` | exact boolean `true` registers `ce_read_payload`; missing/false/malformed stays disabled |
| `inboxNotification.enabled` | exact boolean `true` enables lifecycle-triggered advisory checks; missing/false/malformed stays disabled |
| `inboxNotification.pageSize` | integer 1..50; default 10 |
| `inboxNotification.rawScanLimit` | integer `pageSize`..2000; default 100 |
| `recipients` | optional array of `{ adapter, endpointId }` cross-adapter endpoints this Pi host may send to (the reply path, e.g. a ChatGPT-side MCP endpoint). Any malformed entry, a `pi` adapter entry, a duplicate, or a label colliding with a session endpoint disables the whole list; absent means same-adapter allowlisted recipients only |

Environment: `CE_STORE_DIR` (default `./store` next to this file),
`CE_STORE_FILE` (default `ce-store.sqlite`), `CE_ALLOWLIST`, and
`CE_LEASE_TTL_SECONDS` are honored.

The CE store and its host-secret file are created on first use with the
artifact policy enforced by the storage plane (dedicated directory, mode
checks, no symlinks). The default location is inside this extension
directory, which is covered by the nested `.gitignore` (`store/`,
`allowlist.json`) so the database and the host-secret file can never be
staged; use a dedicated directory per deployment in production.

## Prerequisite

Build the package once so this extension can import the compiled host seam:

```sh
pnpm --dir packages/pi-chat-exchange run build
```

## Smoke (two terminals, one shared store)

Terminal A and B must share `CE_STORE_DIR` (or both use the default and run
in the same installation):

```sh
# terminal A
CE_ALLOWLIST=$PWD/allowlist.json pi --session-id ceA
# terminal B
CE_ALLOWLIST=$PWD/allowlist.json pi --session-id ceB
```

Start and join both Sessions before sending: historical Messages before B's
membership boundary are intentionally ineligible. In A, explicitly call
`ce_send` with `to: "local/sessionB"`. In B, call `ce_inbox_list {}` without
copying A's Message ID into B's prompt, then pass a discovered ID to `ce_read`.
Both tools return metadata only; payloads remain private.

## Explicit Inbox contract

Optional inputs: `afterAuditSequence` (safe integer >= 0, default 0), `pageSize`
(1..50, default 50), and `rawScanLimit` (1..2000, default 2000). After defaults,
`pageSize <= rawScanLimit` is required; e.g. use both limits equal to 1 for a
one-row scan. Unknown fields and authority-bearing parameters are rejected.

Results contain only `{ messages: [{ messageId, auditSequence }],
continuationAuditSequence, scanBudgetExhausted }`. Supply a non-null continuation
as the next invocation's `afterAuditSequence`; it is the last raw Audit actually
examined, including filtered events, not an ACK. Null means no raw row examined.
Budget exhaustion does not promise more eligible Messages; reaching a page limit
does not prove the scan ended. Empty pages do not prove global database integrity,
and Messages without creation Audits cannot be discovered by Audit-first scanning.

Every invocation reads the guarded current Pi context, resolves the allowlisted
endpoint, checks its successful startup binding, and delegates CE authorization
to Storage. No raw Store, capability, digest, payload or internal stack is returned.
BUSY is retryable only by explicit caller action; INDETERMINATE is non-retryable
until the operator reopens and inspects. The tool never renews, reissues or takes over.

## Inbox advisory notification contract (B3-P6B, operator opt-in)

`inboxNotification.enabled` must be the exact boolean `true`. Unknown fields,
prototype-bearing or accessor-backed objects, malformed bounds, and missing/false
settings fail closed to disabled. Advisory configuration never grants CE authority.
Each check reuses the current Session's existing `read` authority through
`host.listInbox`; Storage still validates membership, join boundary, current Owner,
fencing, lease, and capability inside the bounded transaction.

After a successful Session binding and after `agent_settled`, the Extension may
perform exactly one check with its private page and raw-scan limits. It does not
drain another page, poll, start a timer, retry automatically, or wake an idle
runtime. A volatile Audit Sequence watermark avoids rescanning examined rows; it
is never persisted, never written to `delivery_cursor`, and is reset on runtime
replacement or shutdown. Null continuation leaves the previous watermark intact.
Duplicate advisories after a fresh runtime generation are expected.

Published text contains only a bounded item count and fixed advisory wording. It
never contains Message IDs, Audit Sequences, endpoint/Participant/Session/Store
identities, keys, digests, lengths, capabilities, or payload. A saturated page or
exhausted raw-scan budget is labeled incomplete and does not claim a total Inbox
count. Complete zero-result scans stay silent. Notification is not Delivery, ACK,
Read, processing, Result, unread state, or Workflow Completion.

The authority-critical path validates the live Pi Session/endpoint/binding before
discovery and again immediately before publication, with no `await` between those
checks, synchronous `host.listInbox`, and synchronous `ctx.ui.notify`. A stale
Session or runtime generation is dropped silently without watermark advance or
retry. Refusals, unexpected failures, and publication exceptions leave the
watermark unchanged and latch automatic checks off for that runtime generation;
the explicit `ce_inbox_list` tool remains independently usable.

UI delivery is best effort. TUI and RPC use `ctx.ui.notify`; JSON/print or any
context without usable UI skips automatic discovery. PI WEB may retain historical
notifications in its own bounded daemon memory. That history is not the CE Inbox,
dismissal is not ACK or consumption, and a retained notice proves only that an
authorized observation occurred as of that earlier check—not that authority is
current. Generic RPC clients may display, ignore, log, or retain the event. No
successful `ctx.ui.notify` call guarantees display or persistence.

## Authorized payload contract (B3-P4D, operator opt-in)

`ce_read_payload` accepts exactly one input, `messageId`; unknown fields and
any authority-bearing parameters are rejected. It is registered only when the
operator sets `payloadRead.enabled` to the exact boolean `true` — a disabled
deployment registers no payload tool at all, and the host answers
`CE_HOST_PAYLOAD_DISABLED` for direct calls.

Every invocation reads the guarded current Pi context, resolves the
allowlisted endpoint, checks its successful startup binding, and delegates to
the session host, which delegates final authorization to Storage: the exact
`payload_read` capability (independent from the metadata `read` scope),
ATTACHED Session, current Owner, current fencing, active lease, Exchange
membership, recipient-only visibility, exact `message_created` audit
correlation, and the recipient's join boundary — all before payload bytes are
materialized. The fixed exposure limit is 65,536 encoded bytes, checked
before decoding (`CE_HOST_PAYLOAD_TOO_LARGE`); decoding is strict UTF-8
(`CE_HOST_PAYLOAD_INVALID_UTF8`); no truncation, replacement characters,
base64 fallback, chunking, or partial payload ever escapes.

A successful result is two content items — a fixed untrusted-content warning
and the exact decoded payload text — plus metadata-only details. The payload
text never appears in details, logs, failures, or mappings. Successful
content becomes visible to the active model and may enter durable Pi
conversation history; treat it as untrusted data, never as instructions.
Reading performs no ACK, consumption, cursor advance, lease renewal,
ownership change, or automatic retry, and never injects user messages into
any conversation.

## Separate isolated dogfood acceptance (NOT_RUN for this implementation)

Use a disposable work/agent/session directory and dedicated Store, not production
Pi or credential files. Load the candidate Extension and freshly built package.
Use Node 24.21.0 and Pi 0.86.1. Operator-arranged provider access, if needed, is
a separate prerequisite; missing access leaves the smoke NOT_RUN.

1. Run A and B as separate processes with distinct allowlisted Pi Sessions.
2. Verify B joined before A sends. Capture A's send result only as observer evidence.
3. B explicitly lists without knowing A's ID; observer compares the discovered ID.
4. B explicitly reads that discovered ID through `ce_read`; assert metadata only.
5. Compare Message state, ACK and delivery cursor before/after; repeat listing to
   prove it does not consume. A must not list a Message addressed only to B.
6. Use small explicit budgets and returned continuations to check pagination.
7. Test an unallowlisted Session in an isolated replacement process; no metadata.
8. Restart B using its persisted Pi Session within the active lease; validate the
   same CE mapping. Check `/reload` registers the tool once and stale contexts refuse.
9. After lease expiry or terminal detach, assert refusal without takeover or revival.

Record actual tool invocations/results and sanitized durable-state observations.
Model assertions alone are not runtime evidence. Do not interpret metadata listing
or reads as delivery settlement, exactly-once evidence, or Completion Authority.
