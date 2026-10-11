# ce-chat-exchange — CE-0002 B3-P3B minimal Pi extension

Local, Session-authorized, durable Pi-to-Pi messaging over the
`pi-chat-exchange` B3-P3A storage slice. Verified against
`@earendil-works/pi-coding-agent 0.86.1`.

## What it does

- On `session_start`, resolves this Pi session's endpoint from the operator
  allowlist, then either recovers the persisted mapping (reasons
  `startup` / `reload` / `resume`) or provisions a fresh CE Session.
- Registers two LLM-callable tools, `ce_send` and `ce_read`, and the
  `/ce-status` command.
- Persists the mapping (identifiers only) as a `ce-mapping` custom session
  entry via `pi.appendEntry`.
- On `session_shutdown`, drops the in-memory capability row.

## What it deliberately does NOT do

- No ACK, no delivery cursor mutation, no inbox discovery, no background
  polling, no cross-process signalling.
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

In A, ask the model to call `ce_send` with `to: "local/sessionB"`. The tool
result carries the `messageId`. In B, ask the model to call `ce_read` with
that exact `messageId`. B sees metadata only; the payload stays private.
