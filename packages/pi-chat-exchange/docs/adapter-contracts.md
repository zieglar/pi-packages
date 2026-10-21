# Control surface and endpoint contracts — PH-0003

This replaces directional ClientAdapter/AgentAdapter naming with separate planes.
It does not implement delivery, authentication, persistence or full control APIs.

## MCP control (`src/control/mcp/`)

- Today: unchanged read-only `ping`, over stdio, TypeBox validated; malformed
  input is invalid-params, stdout only protocol frames, no environment access.
- Future: translate request/read/cancel operations into authenticated core calls.
  `CONTROL_OPERATIONS` preserve exchange_send/get/list/cancel/result names;
  owner close/archive are separate optional capabilities, not bound tools.
- A tools/call request ID is API correlation, NOT the invoking conversation's
  durable endpoint identity. MCP tasks likewise represent RPC work, not a named
  conversation. Sampling/elicitation does not establish conversation injection.
- A future send call needs an explicitly authorized source EndpointRef binding;
  never invent a native conversation identity from its MCP request ID. An
  origin-only participant may declare delivery unsupported/unknown. That allows
  requests and control-result reads, not a claim that replies can be injected
  into the caller's conversation. No such binding is implemented here.
- The frontend obtains authenticated host authorization and cannot create
  delivery/runtime proof. Host-scoped grants are not accepted as caller credentials.
- CLI, HTTP and native control surfaces are future alternatives, not present.
- PH-0001 plugin/tunnel evidence stays archival; no install/tunnel changes or
  real client invocation have occurred (NOT_RUN).

## Endpoint integration (`protocol/endpoint-capabilities.ts`)

No giant interface or inheritance hierarchy. Minimum declaration:
`EndpointDeclaration { kind, capabilities }`. Delivery support is explicit;
observation/cancellation/follow-up/result-production support is optional and
independent. Each is supported/unsupported/unknown; missing means unknown.
An advertised capability is not a receipt, runtime event, completed Result or grant.

A future binding resolves opaque endpoint identity and supplies correlated delivery
and whatever runtime observations it genuinely supports. Request authority may
also be granted to the same principal for originating another Message; no MCP
control implementation is required to originate a request through the host.
Conversation peers need not support identical observation/cancellation methods.
Missing proof blocks the corresponding transition; no timeout/DOM text/ACK is
promoted to settlement. Confirmed transport with unknown runtime is not reclassified
as ambiguous delivery. Unsupported workflows may be refused before effects by
future admission policy; no such policy or adapter method is implemented here.

## Pi endpoint (`src/endpoints/pi/contract.ts`, declaration only)

- Public owning-session APIs remain sendUserMessage/sendMessage, sessionManager,
  lifecycle events and appendEntry (official 0.86.1 documentation already audited).
- Official handoff summarizes context into a NEW session/editor; it is not an
  existing-session transport. No competing RPC session is created.
- Persistent endpoint maps locally to installation/host + persistent session
  binding; live instance/registration epoch changes on restart. PID, cwd, pane
  ID or runtime alias alone is not durable. No endpoint string grammar is frozen.
- Credentials, provider/session file handles, SSH keys and Herdr metadata remain
  adapter-local. EndpointRef still has exactly adapter/endpointId/instanceId?.
- Durable dedupe, fencing, pre-effect dispatch intent and no-retry ambiguity rules
  must execute before any external effect. Public API availability alone is not
  per-Message acceptance/settlement proof. Cancellation confirmation remains unproven.
- Pi has no implemented support advertisement or delivery code in this phase.
  Existing plugins remain REFERENCE_ONLY; discovery-only composition may be
  considered later. PH-0002 pins and source findings stay in source-reuse-audit.md.

## Future conversation endpoints

No ChatGPT implementation or placeholder directory exists. The four audited bridges
remain REFERENCE_ONLY (chat-bridge-audit-ph0003.md). Private Desktop APIs, CDP,
DOM automation, accessibility drivers and browser extensions are not dependencies.
Control/endpoint and inter-endpoint imports are forbidden; generic contracts/core
are shared inward. A future ChatGPT endpoint must not require MCP SDK or its frontend.

## Authority and evidence

Closed principal/action/scope contexts supplied by the future authenticated host
replace client/agent labels. Owner close/archive, request, delivery, runtime progress,
settlement, publication and cancellation confirmation are independent grants.
Grant matching is pure validation, NOT authentication, evidence provenance or durable
CAS. Host authenticates issuer/principal/endpoint/consumer/owner mappings and loads
all authoritative records in the transaction. See architecture.md for exact scopes.
