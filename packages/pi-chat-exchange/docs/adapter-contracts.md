# Adapter Contracts (PH-0002, frozen 2026-10-06)

Two adapter seams exist. Neither implements exchange operations in this
phase; both are contracts plus (for MCP) the retained ping smoke.

## MCP adapter (`src/adapters/mcp/`)

- **Surface today: strictly the `ping` smoke** — one read-only tool over
  stdio, TypeBox-validated, malformed input rejected with JSON-RPC
  invalid-params, no `process.env` access, stdout reserved for protocol
  frames. The package check gate enforces that no capability operation name
  appears on this surface and that `ping` is the only registered tool.
- **Future generic surface** (declared, NOT implemented): bind
  `CLIENT_OPERATIONS` (`exchange_send/get/list/cancel/result`) as MCP tools
  when the durable host exists. `exchange_close` is a separate OPTIONAL
  capability and stays unbound. A full MCP exchange API remains out of scope
  until then.
- Tunnel/plugin mechanics for reaching this stdio server from a client
  product stay as documented in the archival
  [chatgpt-installation.md](chatgpt-installation.md) (name updated for the
  project rename); real client-product acceptance remains NOT_RUN.

## Pi adapter (`src/adapters/pi/contract.ts` — documentation only)

- Binds the **agent** port to a Pi session via public, owning-session
  extension APIs only: `pi.sendMessage(customMessage, { deliverAs:
  "steer"|"followUp"|"nextTurn", triggerTurn })`, `pi.sendUserMessage` for
  waking an idle session, session identity via `sessionManager`, durable
  extension entries via `pi.appendEntry` — all documented in official
  `extensions.md` (verified at the actual user runtime 0.86.1; the bundled
  handoff example is a new-session/editor-draft flow, not
  existing-session injection evidence). No competing session; RPC mode
  stays rejected. No runtime Pi API calls, no Pi package imports, no install
  in this phase (gate-enforced).
- Endpoint mapping example: `{ adapter: "pi", endpointId: "ep-example-1",
  instanceId: "run-example-2" }`. No endpoint string grammar is prescribed.
  Adapter-local routing associates the opaque persistent endpoint with a durable
  installation/host identity plus persistent Pi session identity (or an explicitly
  persisted endpoint binding for a session without a durable file). A pid, cwd,
  Herdr pane ID, runtime-only alias or in-memory session counter alone is not a
  durable endpoint. `instanceId` is a fresh process incarnation/registration epoch;
  it changes on restart while the persistent binding does not.
  Provider credentials, SSH keys and runtime-specific handles stay adapter-local
  and never enter protocol entities.
- **Receipt integration limitations** (why no third-party composition is
  claimed — details in [source-reuse-audit.md](source-reuse-audit.md)):
  the decisive ground is that none of the audited comm plugins offers a seam
  where our durable dedupe, lease fencing, and explicit no-retry decision can
  run before their own injection/retry machinery (pi-intercom's outbox
  auto-injects from in-memory dedupe and generalizes timeout/session-end
  failures; remote-pi's in-memory buffer drains after a socket-write ACK and
  delegates retry to the sending LLM — that ACK is transport acceptance, a
  fact but not the refusal ground; pi-relay's steer→follow-up→fallback
  catches and claim recovery may have unknown side effects, so no complete
  fail-closed claim is made for composing it). Discovery-only composition
  with an already-installed plugin may be added later.
- **Caveat:** public API availability is not correlated durable
  acceptance/settlement proof; only core-rule-validated attempt evidence
  moves a Message.
