# pi-chat-exchange Architecture — PH-0003 convergence

Approved model C: **ControlSurface + capability-oriented Endpoint integration**.
This supersedes PH-0002's client/agent naming, not its data or safety invariants.
Original PH-0002 architecture remains in commit `5a84cb1`; its evidence/report
is preserved in `ph0002-validation.md`. The separately authorized quarantine
correction is documented in `quarantine-hotfix-ph0003.md` (commit `8f44553`).

```text
Control surfaces (MCP today; CLI/HTTP/native possible, NOT implemented)
                              |
                       Exchange Core
                              |
Endpoint integrations (Pi contract only; no ChatGPT implementation)
```

One private package, no inheritance or multi-package framework:

```text
src/protocol/       neutral entities, identity, lifecycle, action grants/support
src/core/           pure evidence/authorization rules + in-memory reference
src/storage/        private Node 24.21.0 SQLite foundation (not publicly exported)
src/control/mcp/    unchanged ping-only API transport
src/endpoints/pi/   declaration/documentation only
src/bin/           composition-only stdio entrypoint
```

Dependencies point inward: bin -> control/endpoints/private host seams -> core ->
protocol. Private storage may depend on protocol/core concepts but protocol/core
cannot reach storage, filesystem APIs, or `node:sqlite`. The package public barrel
cannot expose storage, SQL-driver, transaction, migration, or private evidence
types. Control and endpoints may use protocol directly. Neither plane imports the
other; endpoint integrations do not import each other or the MCP SDK.
TypeScript-AST gates include import/export, dynamic import, require and transitive
barrels. Virtual negative fixture imports resolve from their declared `@role`,
not their actual `scripts/fixtures` directory; they are not runtime programs.

## Peers, operations and authority

A conversation and a runtime are addressable peers **when an integration
actually provides that capability**. Their support is not assumed identical.
MCP invocation does not by itself identify the caller's conversation or create
a delivery endpoint. Audit evidence is in `chat-bridge-audit-ph0003.md`.

`ControlSurfaceDeclaration` advertises request/read/optional administrative
operations. `EndpointDeclaration` advertises independent tri-state delivery,
observation, cancellation, follow-up and result-production support. Missing
support is unknown. Neither declaration nor a method grants permission or
creates execution evidence. No concrete support is advertised as implemented
by the Pi contract; no ChatGPT integration is present.

`AuthorizationContext` is **trusted host input**, not a bearer credential or
self-issued token. Closed action grants bind principal + exact scope:

| Action | Scope |
| --- | --- |
| send/get/result | Exchange |
| list | collection (host must filter authorized records) |
| cancel request | Exchange + Message |
| claim | Exchange + Message + destination EndpointRef |
| dispatch/delivery/progress/settlement/publication/release/reconcile/confirm | Exchange + Message + Attempt + recipient incarnation |
| close/archive | Exchange + owner principal; separate grants |

Core matches exact scope and principal; different message/attempt/instance
cannot reuse a grant. Transport report authority alone cannot prove runtime
acceptance; reconciliation also needs independently authorized acceptance.
Started runtime cancellation needs cancellation-confirmation AND settlement
reporting authority; never-attempted cancellation does not manufacture a
runtime fact. Runtime permission does not imply owner permission.

## Preserved entities and evidence

Exchange remains the OPEN/CLOSED correlation aggregate. Message already has
`from`/`to` EndpointRefs; reverse-direction communication and follow-ups are
new independent Messages in the same Exchange, not role-specific operations.
Result remains immutable processing evidence/output for one Message/Attempt.
Publishing it does not enqueue a reply, create another Message or close the
Exchange. Reads remain repeatable, deeply immutable and non-semantic.

Dispatch intent precedes effects; live mutations require the current fenced
claim. Proven not-attempted release cannot contradict transport facts.
Potential delivery ambiguity is quarantined with no retry/requeue. Correlated
RuntimeEvidence is independent of transport receipts. Known delivery plus
unknown execution is **not** delivery ambiguity and cannot synthesize acceptance,
settlement or a Result. Unsupported workflows may be rejected before effects
by future admission policy; that policy is not implemented here.

Cancellation cannot erase ambiguity. Normal close requires every message to
be finished. Separately, `ABANDONED_UNRESOLVED` administrative disposition
preserves unknown execution/ambiguous attempts, disables further protocol
activity and never implies cancellation, normal close or success.

## Private durable storage foundation

`src/storage/` now provides the B1-only file-backed foundation for a future host:
an exact runtime/SQLite/source-id eligibility gate, an initialized `node:sqlite`
writer connection, `BEGIN IMMEDIATE` transactions, a version-1 private schema,
store UUID/application identity, a checksummed migration ledger, integrity and
restore-hold validation, and restrictive local-filesystem checks. It is deliberately
absent from `src/index.ts`; there is no public storage or business-operation API.

Writable storage fails closed unless Node is exactly 24.21.0, SQLite is exactly
3.53.4 with the approved source identity, and the target is macOS arm64 or Linux
x64. Every writer uses defensive mode, WAL, synchronous FULL, foreign keys,
trusted-schema OFF, bounded busy waiting, and an explicit auto-checkpoint policy.
macOS writers additionally require fullfsync and checkpoint_fullfsync.

Callers must supply an explicit non-Pi database directory. The foundation requires
an approved detectable local filesystem, current-user ownership, directory mode
0700, DB/WAL/SHM mode 0600, non-symlink final artifacts, and a restrictive umask
during creation. These checks reduce ordinary deployment mistakes; they do not
eliminate every TOCTOU race, mount substitution, OS-crash, or power-loss risk.
Linux x64 remains subject to native CI qualification.

The schema contains only private persistence structures for accepted entities and
invariants. It does not dispatch messages, invoke endpoints, publish Results, run
reconciliation, retry remotely, or make an exactly-once remote-delivery claim.
Unknown migrations, foreign/newer stores, checksum mismatches, failed integrity
checks, and restore-held stores are rejected; stores are never reset automatically.

## Future host responsibilities and scope limit

The host must authenticate the actual adapter/runtime/principal, load current
grants/owner binding/Message/active Attempt/latest claim/disposition/full message
set/published Result, and check-and-commit atomically. It must enforce admission
and evidence provenance. Caller-supplied contexts, current leases or proof
snapshots are never authoritative. Publication's immutable/scoped helper and
the transition to RESULT_AVAILABLE must be checked together against authoritative
settlement facts; readResult is a pure snapshot helper, not an ACL service.

No business mutation API, claim/fencing allocator, authentication, broker, API
operation, Pi/ChatGPT delivery, listener, daemon, tunnel, CDP/browser extension or
production installation is implemented. MCP remains ping-only; actual
desktop-product invocation acceptance remains NOT_RUN.
