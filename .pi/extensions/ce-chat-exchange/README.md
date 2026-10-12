# ce-chat-exchange — CE-0002 B3-P3D explicit Inbox tool

Local, Session-authorized messaging with explicit bounded Inbox discovery.
The B3-P3B runtime slice was verified against Pi 0.86.1; the new Inbox tool
has isolated harness coverage. Real two-process Inbox dogfood is a separate
acceptance phase and is not claimed by these instructions.

## What it does

- On `session_start`, resolves this Pi session's endpoint from the operator
  allowlist, then either recovers the persisted mapping (reasons
  `startup` / `reload` / `resume`) or provisions a fresh CE Session.
- Registers `ce_send`, `ce_read`, `ce_inbox_list`, and `/ce-status`.
- Persists the mapping (identifiers only) as a `ce-mapping` custom session
  entry via `pi.appendEntry`.
- On `session_shutdown`, drops the in-memory capability row.

## What it deliberately does NOT do

- No ACK, delivery cursor mutation, automatic consumption, background polling,
  automatic page draining, or cross-process signalling.
- No external delivery: writing to SQLite never makes a message visible in
  another Pi conversation. `ce_read` returns metadata only, and the payload
  never leaves the private storage plane.
- No automatic takeover recovery (`CE-TAKEOVER-RECOVERY-CALLER-001` stays
  unresolved). An expired lease fails closed with `CE_HOST_AUTHORITY_ABSENT`.
- A forked or newly created Pi session never inherits the previous mapping:
  fork/new reasons ignore inherited `ce-mapping` entries entirely.

## Trust boundary

- The **allowlist is the only registration authority**. Pi session ids are
  untrusted lookup labels; they select an endpoint label and authorize
  nothing. Model/tool arguments can never register Participants, issue
  capabilities, or change ownership — they only pick a recipient label,
  message text, and an idempotency key.
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
