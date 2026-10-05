# pi-chat-exchange

Generic chat-exchange protocol: an **Exchange aggregate** with independently
tracked **Messages**, **DeliveryAttempts**, and immutable **Results**.
Renamed from `pi-handoff` by PH-0002 (the approved architecture correction);
package history is preserved via git moves. Private package, not for
publication.

Status (this package):

- **Frozen v2 protocol contracts** — identity (legacy `ho_` for Exchange,
  `hr_` for Result, additive `msg_/att_/rcpt_/evt_`), the evidence-gated
  message lifecycle with fail-closed `DELIVERY_UNKNOWN` quarantine, generic
  EndpointRef / Lease / Receipt / Consumer / Event schemas, neutral
  Client/Agent capability ports. See [docs/protocol-v2.md](docs/protocol-v2.md).
- **Pure core rules** — transition legality with correlated evidence
  (message/attempt/endpoint/lease fencing), explicit exchange close,
  non-mutating immutable result reads, publish-once results, plus the
  in-memory idempotency REFERENCE store. See [docs/architecture.md](docs/architecture.md).
- **Adapters as seams** — MCP: strictly the retained `ping` smoke over stdio;
  Pi: contract documentation only (no runtime Pi API use, no install). See
  [docs/adapter-contracts.md](docs/adapter-contracts.md) and
  [docs/source-reuse-audit.md](docs/source-reuse-audit.md) for why no
  third-party composition is claimed.
- **Deferred** — the durable host (broker/storage/API server), every
  exchange operation beyond `ping`, and real client-product acceptance
  (NOT_RUN).

## Architecture

```text
src/bin        composition only (stdio MCP entrypoint)
src/adapters   mcp = ping smoke only · pi = contract docs only
src/core       pure rules + in-memory idempotency reference
src/protocol   neutral schemas, lifecycle tables, capability ports
```

Dependency direction (gate-enforced from the TypeScript AST, with negative
fixtures proving rejection): `bin → adapters → core → protocol`; protocol
never reaches core/adapters; core never reaches adapters; the adapters never
reach each other; protocol/core stay product-neutral.

Ownership boundaries (frozen):

- The **client port** sends, inspects, lists, requests cancellation, and
  reads results. Explicit close is a separate optional capability. It can
  never fabricate execution outcomes.
- The **agent port** alone claims, marks durable dispatch-start, reports
  delivery/activity/settlement, publishes results, releases leases,
  reconciles ambiguity, and confirms cancellation.
- **Core rules** are the only legality authority; compile-time checks are a
  development aid, never an authorization mechanism.
- Reads never mutate lifecycle state; there is no CONSUMED; an Exchange
  closes only when every message is finished (nothing in flight, nothing
  quarantined).

## Usage

```bash
pnpm install
pnpm run check        # AST architecture gates + negative fixtures
pnpm run typecheck    # includes compile-negative @ts-expect-error tests
pnpm run build        # emits dist/ (required before the stdio smoke test)
pnpm test             # vitest; the stdio smoke FAILS if dist/ is missing
node dist/bin/mcp-stdio.js   # serve the ping smoke over stdio
pnpm run verify       # check → typecheck → build → test (build before test)
```

## Security notes

- Never persist or expose credentials, API keys, auth files, environment
  secrets, or hidden model reasoning. Payload/result bodies are sensitive
  data: correlated by digest in diagnostics, never copied into logs or
  events (events carry IDs, digests, lengths, typed outcomes only).
- Endpoint identity is opaque, non-secret routing identity; credentials stay
  adapter-local.
- The MCP surface performs no `process.env` access; `scripts/check-contract.mjs`
  enforces this along with the layering gates.

## License

Private package during bootstrap. Preferred license: Apache-2.0, pending the
same provenance review policy as the rest of this workspace. Not for
publication until that review completes.
