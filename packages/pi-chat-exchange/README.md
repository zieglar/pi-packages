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
  action-scoped authorization and independent endpoint capability support. See
  [docs/protocol-v2.md](docs/protocol-v2.md).
- **Pure core rules** — transition legality with correlated evidence
  (message/attempt/endpoint/lease fencing), explicit exchange close,
  non-mutating immutable result reads, publish-once results, plus the
  in-memory idempotency REFERENCE store. See [docs/architecture.md](docs/architecture.md).
- **Separate planes** — MCP control surface: strictly retained `ping` smoke;
  Pi endpoint: declaration/documentation only. No ChatGPT endpoint implementation.
  See [docs/adapter-contracts.md](docs/adapter-contracts.md),
  [docs/chat-bridge-audit-ph0003.md](docs/chat-bridge-audit-ph0003.md) and
  [docs/source-reuse-audit.md](docs/source-reuse-audit.md) for pinned source evidence.
- **Deferred** — the durable host (broker/storage/API server), every
  exchange operation beyond `ping`, and real client-product acceptance
  (NOT_RUN).

## Architecture

```text
src/bin          composition only (stdio MCP entrypoint)
src/control/mcp  ping-only control/API surface
src/endpoints/pi endpoint integration contract only
src/core         pure evidence/authorization rules + in-memory reference
src/protocol     neutral entities/lifecycle/action grants/support declarations
```

Dependency direction (gate-enforced from the TypeScript AST, with negative
fixtures proving rejection): `bin → control/endpoints → core → protocol`.
Protocol/core cannot reach outer layers; control and endpoints cannot reach
each other; endpoints cannot depend on peer integrations or the MCP SDK.
Protocol/core stay product/transport neutral.

Ownership boundaries (frozen):

- Conversations and runtimes can be peer endpoints without equal capabilities.
  MCP invocation is not delivery to the invoking conversation.
- Request, delivery, runtime reporting, result publication, owner close and
  owner archive require separate principal-bound, exact-scope host grants.
  Caller labels, interfaces and capability advertisements are NOT authentication.
- Correlated evidence, latest claims/fencing and disposition remain independent
  preconditions. Dispatch intent precedes effects; ambiguous delivery never retries.
- Result is immutable processing evidence; a reply/follow-up is another Message.
  Reads never consume/close. Normal close requires every Message to be finished.
- The authorized `ABANDONED_UNRESOLVED` disposition preserves unknown facts while
  disabling protocol activity; it is not cancellation or normal close.
- Persistence, authentication, admission policy and real endpoint integration
  remain unimplemented.

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
