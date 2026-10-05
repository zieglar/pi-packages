# pi-handoff

Durable handoff protocol between ChatGPT and the local Pi agent runtime.

`pi-handoff` eliminates the manual copy/paste ambiguity in the current
ChatGPT → human → Moshi/Herdr → Pi → human → ChatGPT loop. A **handoff is a
durable protocol entity, not a message**: every handoff has a stable identity,
an explicit lifecycle, idempotent creation, and an auditable event history.

Phase 0/1 status (this package):

- **Frozen v1 protocol contracts** — identity, lifecycle state machine,
  idempotency, ambiguous-delivery rule, ChatGPT MCP surface, internal Pi
  consumer surface, result envelope. See [docs/protocol-v1.md](docs/protocol-v1.md).
- **Evidence audit** — [docs/phase-0-evidence.md](docs/phase-0-evidence.md).
- **MCP smoke server** — one strictly read-only `ping` tool over stdio, proving
  the ChatGPT → plugin/MCP → pi-handoff path. See
  [docs/chatgpt-installation.md](docs/chatgpt-installation.md).
- **Deferred** — the durable broker, the Pi extension, and all
  `handoff_*` tools beyond `ping`. Do not implement before Phase 2.

## Architecture (long-term target)

```text
ChatGPT Desktop
        │
        ▼
ChatGPT local Plugin / MCP   (Create custom MCP server + Secure MCP Tunnel)
        │
        ▼
pi-handoff durable broker    (deferred; SQLite proposal in docs/persistence-proposal.md)
        │
        ▼
pi-handoff Pi extension      (deferred; consumes handoffs via public Pi extension APIs)
        │
        ▼
existing Pi AgentSession     (pi.sendUserMessage — public API, no competing session)
```

Ownership boundaries (frozen):

- The **ChatGPT MCP surface** creates, queries, lists, cancels, and reads
  results. It can never fabricate Pi execution results.
- The **broker** owns durable identity, lifecycle state, idempotency,
  claim/lease state, delivery records, result persistence, and event history.
  It does not judge semantic correctness.
- The **Pi extension** consumes eligible handoffs and delivers prompts into its
  *owning* session via the public `pi.sendUserMessage()` API. It never launches
  a competing Pi runtime.
- **Wayforge is not a dependency.** Future application-level completion
  evidence may be published as opaque `applicationEvidence`.

## Usage

```bash
pnpm install
pnpm run check        # static contract gates
pnpm test             # vitest (RED→GREEN protocol + MCP smoke tests)
pnpm run typecheck
pnpm run build        # emits dist/ (required for the stdio integration test)
node dist/bin/mcp-stdio.js   # serve MCP over stdio
```

## Security notes

- Never persist or expose credentials, API keys, auth files, environment
  secrets, or hidden model reasoning. Prompt/result bodies are sensitive
  payload data: persisted with restrictive permissions, correlated by digest
  in logs, never copied into diagnostics.
- The `ping` tool exposes only `platform + release` as a host label — no
  hostname, username, home path, or environment values.
- The MCP surface (`src/mcp/`, `src/bin/`) performs no `process.env` access;
  `scripts/check-contract.mjs` enforces this.

## License

Private package during Phase 0/1 bootstrap. Preferred license: Apache-2.0,
pending the same provenance review policy as the rest of this workspace.
Not for publication until that review completes.
