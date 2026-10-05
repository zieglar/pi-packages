# Persistence Proposal — pi-handoff broker (Phase 2+, design only)

Default store: **SQLite** (boring, transactional, single-file, WAL-capable).
No credential storage of any kind.

## Location

```
~/.local/share/pi-handoff/handoff.db      (database)
~/.local/share/pi-handoff/consumer.token  (0600, loopback HTTP bearer token)
```

Directory `0700`, database file `0600`. XDG-style path keeps the broker
independent of Pi's own config directory so it can run standalone; a macOS
`~/Library/Application Support` variant is acceptable if project conventions
later require it, but the XDG path is the frozen default for CLI tooling here.

## Entity-relationship sketch

```text
consumers  1─n  handoffs (claims)      handoffs  1─n  deliveries
handoffs   1─n  results                handoffs  1─n  events (immutable)
```

Logical entities (physical DDL is Phase 2 work):

- **handoffs** — handoffId (PK), state, idempotencyKey (unique per namespace),
  promptDigest, promptLength, promptBody (sensitive, separate column or
  sidecar), workspace, metadata JSON, createdAt, updatedAt. State transitions
  occur only inside transactions guarded by the frozen state machine.
- **deliveries** — deliveryId, handoffId → handoffs, attempt, consumerId,
  claimedAt, leaseUntil, deliveredAt, deliveryRecord JSON (proves
  attempted/not-attempted for the fail-closed rule).
- **results** — resultId (PK), handoffId → handoffs, attempt, envelope JSON,
  inputDigest, resultDigest, applicationEvidence JSON (opaque).
- **events** — eventId, handoffId, seq (monotonic per handoff), type
  (state_transition, claim, heartbeat, delivery, settlement, consumption,
  cancel), payload JSON (digests/lengths/typed status only — never raw prompt
  or result bodies), at. **Append-only, immutable.**
- **consumers** — consumerId, label, registeredAt, lastSeenAt, tokenDigest
  (never the token itself).

## Hard requirements

- Transactional state transitions (state machine enforced in the same
  transaction as the event append).
- `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`.
- Schema versioning via a `schema_migrations` table; migrations run at broker
  startup, never by tests against production data.
- No credential material in the database or event payloads; secrets that
  must transit (e.g. the consumer bearer token) live in `0600` files outside
  the DB, stored digested.
- Diagnostics and logs reference IDs, digests, lengths, and typed status.
