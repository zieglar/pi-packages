[English](architecture.md) | [简体中文](architecture.zh-CN.md)

# pi-chat-exchange developer architecture

This guide describes the boundaries between messages, Endpoint/Session authority, transport and the Pi adapter. Start with [getting started](getting-started.md) for installation and [multi-session usage](multi-session-usage.md) for multiple projects. Protocol, Storage and Ownership contracts and source gates define the precise constraints.

<a id="分层与依赖方向"></a>
## Layers and dependency direction

```text
ChatGPT (Tunnel MCP / Desktop stdio)          Pi runtime
              |                                  |
        src/bin + src/control/mcp          pi-extension/index.ts
              |                                  |
              |                          src/endpoints/pi
              +---------- src/host ---------------+
                              |
                         src/storage
                              |
                           src/core
                              |
                         src/protocol

src/tunnel: transport/profile/setup/Manager; does not replace CE Host authority
```

| Layer | Responsibility | Boundary |
|---|---|---|
| `src/protocol/` | Neutral entities, lifecycle, action grants, support declarations | No Pi, MCP, network or database dependencies |
| `src/core/` | Pure evidence/authorization rules, reference in-memory behavior | No environment or file reads or real endpoint calls |
| `src/storage/` | Private SQLite, transactions, schema/migrations, Ownership/fencing, final data authorization | No private SQL/migration/evidence types in the public barrel |
| `src/host/` | Adapter-neutral durable Endpoint Host, trusted binding, Session, idempotent messages and receipts | No sender/capability from tool arguments; no outer workflow completion authority |
| `src/control/mcp/` | MCP schemas/output; ping by default, messaging with an injected bound port | No arbitrary environment reads, direct Pi integration imports or ChatGPT conversation identity inferred from invocation |
| `src/endpoints/pi/` | Thin Pi Session host adapter | No MCP SDK or other endpoint integration imports |
| `src/bin/` | Stdio composition root, trusted absolute `--config`, process lifecycle | No second message broker or parallel authority |
| `pi-extension/` | Runtime Session lookup, tools/commands, lifecycle, UI, mapping identifiers | No persisted capability; Storage decides visibility |
| `src/tunnel/` | Client lifecycle, health measurement, private configuration transactions, masked input and explicit activation UI | CONNECTED is not a message gate; no implicit read/ACK/retry |

Core dependencies point inward: `bin → control/endpoints/host → storage → core → protocol`. TypeScript AST gates in `scripts/check-contract.mjs` define permitted imports. Protocol/core cannot reach outer layers; control and endpoints cannot import each other. Barrels, dynamic imports and require cannot bypass these rules. Tunnel is outer composition and gains no protocol authority. Shared behavior belongs in existing Host/Storage seams, so ChatGPT and Pi do not acquire separate Message systems.

<a id="身份模型与注册权威"></a>
## Identity and registration authority

- Exchange is an association aggregate, not a conversation or transport connection. Namespace/idempotencyKey only provide deterministic bootstrap.
- EndpointRef `{adapter, endpointId}` is non-secret identity. The initial pair is `chatgpt/main` and `pi/main`. Each Pi Session explicitly registers a separate stable Endpoint, such as `pi/project-B`. Endpoints have independent authority and Owners. A shared ChatGPT inbox does not isolate conversations.
- Participant is registered in a Store/Exchange, separately from the current Session/incarnation.
- CE Session / Ownership / fencing identify active execution authority and incarnation. Membership, lease, current owner, fencing and an exactly scoped capability must all pass validation.
- The Pi runtime Session ID comes from the trusted Pi API and selects an operator allowlist entry. It is neither a CE Session ID nor a credential that permits messaging on its own.
- A recipient label uses the exact endpointId in tool `to`; it is not authentication. Labels, support declarations, available tools and UI selection do not grant authority.
- A capability is scoped authority held in Host memory. It is never written to mappings/logs/configuration or selected by the model.

MCP identity is fixed by operator-owned `--config`, not by an MCP invocation or ChatGPT text. Pi identity is fixed by the trusted allowlist and current context. Both sides share the exact Store directory/file and Exchange namespace/key; differences have no automatic routing compensation. `managed`/`managedBy` record provenance and do not replace recipient or Storage checks.

<a id="多-session配置准入不取代-durable-authority"></a>
### Multiple Sessions: configuration admission and durable authority

`src/tunnel/{multi-session-policy,multi-session-admission}.ts` manage the immutable registration policy selected by the profile. `pi-extension/multi-session-runtime.ts` manages the current process guard. Registrations bind trusted native Pi Sessions to stable Endpoints, active/revoked state and epoch. Payload/ACK are independent opt-ins. Project paths and model arguments do not determine identity.

- Convert/register/revoke require human confirmation, configuration revision validation and a verified STOPPED transport lock. They do not start/stop transport or constrain an old binary still running.
- Pi factory grants remain fixed until reload. An MCP child cannot claim a new generation before explicit Stop/Start. Selected configuration, loaded policy, binding and connection are reported separately.
- Deny-only gates constrain later admission, including read/renew; already admitted operations may finish. Normal end/release remains possible. Revocation removes no Owner, Participant, historical message or Receipt.
- The process mutex provides local exclusion, not CE authority/recovery. Runtime/epoch/Store/Exchange and guard must agree; original Host/Storage checks make the final authorization decision. This adds neither takeover nor a cross-Exchange router.
- `/ce-tunnel sessions` projects the selected active Endpoint IDs only after admission of the current runtime. It reads no Inbox and does not prove the running MCP loaded that policy.

<a id="messagedeliveryattemptreceiptresult-的分离"></a>
## Message, DeliveryAttempt, Receipt and Result

1. `ce_send` persists a logical send as an independent Message. Message, idempotency record and creation Audit commit in one local Store transaction. This proves neither cloud transmission nor peer reception. Keys are scoped to the Exchange: the same key/request replays the original record; changed text or Endpoint conflicts. This grants no retry permission after an unknown outcome and promises no exactly-once delivery/execution. Replies and follow-up questions are new Messages, not variations of Result.
2. Inbox performs a bounded scan by creation Audit and applies recipient/membership/join boundaries. It neither ACKs nor consumes messages or advances a delivery cursor.
3. Metadata read and payload read have separate permissions. Storage authorizes payload access before materializing bytes.
4. ACK appends an immutable reception receipt: first CREATED, then REPLAYED. Message creation Audit sequence and receipt Audit sequence are distinct evidence.
5. Result is immutable processing evidence. Publishing it does not automatically reply, close an Exchange or grant Wayforge completion authority.

The full pure-core delivery lifecycle still constrains claim, dispatch intent, attempt, runtime evidence, settlement and quarantine. Durable message/ACK tools do not establish implementation of every remote delivery/execution/result flow.

Frozen safety semantics require intent before effect and related Message/Attempt/Endpoint/incarnation/lease/fencing evidence. Ambiguous delivery enters `DELIVERY_UNKNOWN`, with no retry/requeue and no conversion to `CANCELLED`. Known delivery with unknown execution cannot synthesize acceptance/settlement/Result. Ordinary close requires all Messages to finish. Separately authorized `ABANDONED_UNRESOLVED` preserves unknown facts and means neither cancellation, normal close nor success.

CE Receipts, Pi UI notifications, Tunnel health, runtime execution facts and Wayforge workflow decisions provide different evidence. Wayforge governs tasks, policy, recovery and completion; CE governs message delivery, lifecycle, evidence and reconciliation; Pi governs sessions, runtime and provider transport. External completion actions require their own explicit authorization and evidence. ACKs and model assertions cannot supply those. Switching models does not authorize replay of effects.

<a id="生命周期并发与恢复边界"></a>
## Lifecycle, concurrency and recovery

- MCP startup binds with `requireUnowned`; an independent heartbeat renews the lease. SIGINT/SIGTERM/stdio-close perform release/end once, without taking over a crashed Owner.
- Pi `session_start` selects an Endpoint through trusted runtime lookup. Startup/reload/resume with a mapping validates recovery. Reload without a mapping refuses; new/fork Sessions inherit no old authority.
- Pi reload ends the old in-memory generation/timer while preserving valid durable Ownership. Normal exit/Session replacement attempts end/release/detach. Unknown renew/end or failed diagnostic persistence blocks subsequent paths.
- `ce-mapping`, `ce-messaging-released` and `ce-lifecycle-blocked` hold identifiers/refusal evidence, never capabilities. Markers are not locks or fencing tokens. A release marker alone grants no new authority: exact released+detached proof for the old mapping is required.
- Explicit activation checks current configuration/environment/runtime under the profile lock; only requireUnowned can bind. An existing matching valid binding is a no-op. Unknown release, mapping write failure or mismatched old Exchange evidence refuses, without automatic takeover.
- `/ce-tunnel deactivate` confirms and checks the current generation/Session fence, then uses the normal `shutdownCe()` path. It releases only the local CE binding and retains registration/history/transport. Unknown end or failed evidence persistence keeps operations closed. Reload does not rebind a released mapping; explicit activate can request new authority.
- Tunnel manages detached-client process ownership, not CE Ownership. A cross-process directory lock, PID+exact command+start key and write-ahead termination ledger prevent mistaken termination/duplicate starts. UNKNOWN does not mean a process disappeared.
- Each record-backed run permits at most one SIGTERM, no SIGKILL or name-based bulk kill. A signal lost after persisted intent can mean zero actual signals. Do not delete the ledger to resend. The client owns its MCP child; Manager cannot arbitrarily terminate it.

The recovery CLI is a separately authorized operator-only path, neither an MCP tool nor an automatic model action. Process recovery, CE Owner recovery and investigation of unknown message outcomes are separate problems.

`/ce-tunnel doctor` is an independent read-only installation diagnostic. Host qualification, child executable qualification and client metadata trust remain separate. It reuses executable admission without starting Manager/client, reading credentials/Store or publishing configuration. It does not prove the saved profile child command, client schema compatibility, cloud permissions or network health; configuration, real compatibility tests and Manager supply those separate kinds of evidence.

<a id="配置-generation-与原子迁移"></a>
## Configuration generations and atomic migration

Source: `src/tunnel/{profile,managed-binding,messaging-config,setup}.ts`; UI: `setup-ui.ts` / `secure-input.ts`; loading/activation: `pi-extension/index.ts`.

- Profile is the sole activation pointer. Ordinary bindings derive from full Tunnel/Organization/adapter identity. The short filename suffix is display only and does not compare full identities.
- Advanced Messaging publishes a complete binding and Pi allowlist sidecar named `messaging-<full SHA-256>.yaml` and its `.pi-allowlist.json`. The digest covers both byte sequences. Generation publication uses a no-overwrite link; the loader rejects incomplete/mismatched pairs.
- Publishing two files is not a cross-file crash-atomic operation. The final profile temp+rename is the logical commit point. Failure can leave unselected private staging/generations; it does not roll back or remove files of uncertain ownership.
- Credential replacement first creates a 0700 directory and 0600 exclusive generation, syncs directory/content, then commits the reference. macOS first clears inherited ACLs. Keep does not read content. Old generations remain, with no automatic GC.
- Postcommit sync failure reports durability uncertain, not rollback. UI wording cannot make ACTIVE/UNKNOWN editable.
- `/ce-tunnel migrate` repairs only canonical generated YAML: removes admin_ui entries rejected by client 0.0.16 and repairs the approved Node command, preserving identity/credential reference/binding/Store/recipient bytes. It is not an arbitrary YAML formatter.

<a id="storage-运行契约"></a>
## Storage runtime contract

The current development candidate declares Node **>=24.20.0 <=24.22.1**. Internally, stable Node 24 (>=24.12.0), 25 and 26 are only candidates, not a compatibility promise. Admission requires SQLite **>=3.51.3** (excluding the known WAL-reset defect), readable and well-formed source identity, compile options `THREADSAFE=1` and `MUTEX_PTHREADS`, absence of `OMIT_WAL`, `OMIT_FOREIGN_KEY`, `OMIT_TRIGGER`, `OMIT_CHECK`, `OMIT_COMPILEOPTION_DIAGS`, and shared probes for defensive mode, statements, transaction/savepoint authorizers, commit/rollback, STRICT, JSON, CHECK, FK and triggers. Exact SQLite 3.53.4/source-ID equality is no longer required. Node 24.19.0 and 25.9.0 are explicitly refused after isolated reproduction of native transaction-close SIGSEGV; Node 26.12.1 is preview only. Runtime refusal occurs before Store path preparation; version labels are not qualification evidence. The platform allowlist remains macOS arm64 / Linux x64; local runtime regression evidence is macOS arm64. See [runtime support](runtime-support.md). The published npm 0.2.0 exact allowlist is unchanged.

Driver selection defaults to `node-sqlite` and never falls back after native failure (`src/storage/sqlite-driver-selection.ts`). Production native SHA256 pins remain null in `src/storage/native-compat.ts`, so release availability alone does not authorize native loading. Historical release evidence covers immutable `ce-sqlite-v0.1.0`, ABI 1, SQLite 3.54.1, source `a8386aafd657c84825b2905847f34a43d5b91e1e`, including download/attestation verification. Hosted Native Store integration covers macOS arm64 / Linux x64; macOS x64 / Linux arm64 have artifact/conformance evidence only. See [native SQLite](native-sqlite.md).

Filesystem ownership, 0700/0600, symlink restrictions, writer WAL/FULL, foreign keys, trusted-schema OFF, bounded busy wait and macOS fullfsync/checkpoint_fullfsync remain required. Migration ledger/checksum, application/store identity, integrity and restore hold refuse foreign/newer/corrupt Stores without automatic reset. A working Pi UI does not prove the Store can open. `src/storage/runtime.ts` and the [Storage contract](storage-contract.md) define admission. In-memory probes cannot prove disk locking or crash durability; file permissions cannot eliminate every TOCTOU, mount substitution, OS crash or power-loss risk.

<a id="验证层次"></a>
## Verification layers

Run from the package directory with an approved Node:

```bash
pnpm run check
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:plugin-package
# Optional: requires a locally installed tunnel-client; outside default gates
pnpm run test:installed-client
# Optional: real Pi CLI + PTY crash/resume regression; several minutes, outside default gates
CE_HOST_REGRESSION_KEEP=1 pnpm run test:host-regression
# Complete serial gate (build before test)
pnpm run verify
```

| Layer | Evidence | Does not replace |
|---|---|---|
| AST/type/compile-negative | Dependency direction, closed schemas, type refusals | Real runtime/client behavior |
| Core/protocol unit | Pure transitions, scope, quarantine/authority | File transactions/remote outcomes |
| Storage transactions/faults/multiprocess | Identity, lease/fencing, crashes, concurrency, read/ACK privacy | ChatGPT UI/cloud connection |
| Host/MCP/Pi isolated harness | Arguments, discovery, mappings, activation, payload/ACK, lifecycle | Physical terminals/end-to-end user gates |
| Tunnel offline / TUI harness | Synthetic health, cancellation/in-flight/notifications/screen contracts | Real client schema, authentication, billable connection, physical terminal behavior |
| `test/tunnel/real-client-compat.test.ts` | Real client doctor/local schema compatibility; optional `pnpm run test:installed-client`, requires installed client, skips on unavailability; excluded from `pnpm test` and `pnpm run verify` | Real network readiness/bidirectional messages |
| `test/tunnel/offline.integration.test.ts` | Real client offline integration in the same optional lane; missing client fails loudly; excluded from `pnpm test` and `pnpm run verify` | Real network readiness/bidirectional messages |
| `test/host-regression/real-host-recovery.test.ts` | Real Pi 1.3.0 CLI + real PTY: crash → mutex refusal → offline reconcile → resume → lease renewal → authorized route completion → narrowed-policy refusal → expired Owner refusal, including reason/hint, fencing and slot counts. Optional `CE_HOST_REGRESSION_TEST=1 pnpm run test:host-regression`; first builds out of tree with `git archive HEAD` and compares blob identity. Synthetic Store/loopback provider only, zero tunnel-client executions. Missing prerequisites/opt-in fail loudly; excluded from `pnpm test` and `pnpm run verify` | Real Tunnel/Exchange, credentials/network, ChatGPT UI, installed client, Operator Recovery execution |
| Packaged plugin tests | Portable package contents, stdio startup, discovery | Desktop installation menus/eligibility/conversation updates |
| Manual real gate | Actual send/list/read/ACK between the current ChatGPT conversation and Pi, Tunnel start/stop | Cold startup, all platforms/clients, release qualification |

Real Host lane evidence remains in its original temporary root. `CE_HOST_REGRESSION_KEEP=1` retains successful runs. Test, process/provider cleanup (including local timeout) or cleanup-record failures prevent deletion and attempt to print the original path. The root is removed only after all tests succeed, the driver awaits/reaps its own children, the synthetic provider closes, cleanup recording succeeds and KEEP is absent. Recursive deletion failure can partially remove evidence; the aggregated error marks `possibly-partially-removed` and attempts to print the original path, without promising complete retention. For both offline reconciliations the driver confirms and records exit/reaping identity for the current launch instance, and checks for live owned Store-capable processes before and after the serial offline window. Unconfirmed exit refuses execution; `/quit` plus a fixed wait is insufficient. Default-collected `test/host-regression/*-cleanup.test.ts`, `failure-path.test.ts` and `refusal-comparator.test.ts` cover only synthetic cleanup, offline barriers, failure evidence state and full message/audit array comparison before/after refusal. They start no real Pi/client or business recovery.

Local tests support only their fixed versions/environments; disclose skips/platform limits. Manual messaging acceptance and isolated regression do not replace one another. Historical test counts are not fresh execution evidence for a new change. See the [README](../README.md) for public acceptance boundaries.

<a id="高价值回归入口"></a>
### Useful regression entry points

- `test/tunnel/{setup-messaging,messaging-config,messaging-config-security,messaging-binding}.test.ts`: pairing, immutable publication, permissions/files and failures.
- `test/endpoints/pi/extension-messaging-activation.test.ts`: old mapping release, reload, explicit activation, deny paths.
- `test/endpoints/pi/extension-ack.test.ts` and `test/control/mcp/messaging-ack-tool.test.ts`: independent opt-ins, four fields, model-visible metadata.
- `test/tunnel/{background-manager,extension-deferred-start,real-client-compat}.test.ts`: process evidence, asynchronous start, real schema.
- `test/storage/delivery-ack*.test.ts`, `inbox-*.test.ts`: receipts, privacy, transaction/process boundaries and pagination.

<a id="扩展点与已知债务"></a>
## Extension points and known debt

- New ControlSurfaces must use the existing Host port, closed request schemas and adapter-neutral rules. Untrusted labels cannot self-authorize.
- New endpoint integrations declare independent support. Peer capabilities need not be symmetric; unsupported/unknown remain explicit until real evidence supports implementation claims.
- New client versions need real schema/doctor regression, beyond offline fixtures. New Node/SQLite/platform combinations need independent qualification without weakening runtime guards.
- UI/asynchronous work must preserve draft/commit boundaries, Session generation, in-flight coalescing and separate cancellation/teardown authority. Successful notification is not successful display/delivery.
- Outstanding work includes explicit safe credential/generation GC, machine cold startup, some physical terminal interactions and controlled client installation/upgrades. Desktop supports explicit local approved Node configuration for a private copy; this establishes neither automatic cross-machine installation nor Desktop UI acceptance.
- Outside current scope: automatic Inbox draining/idle wake, business retries/Owner takeover, remote execution, arbitrary Store merges/cross-Exchange routing, or ACK as task completion.

<a id="文档事实溯源与维护"></a>
## Evidence and maintenance

| Claim | Primary source/evidence |
|---|---|
| Versions/scripts | `../package.json`, root `package.json`, `src/storage/runtime.ts` |
| Pi loading/session_start/reload | Pi 1.3.0 CLI help/extensions documentation and runtime `AgentSession.reload`; package `pi-extension/index.ts` |
| Tunnel fields/format/child environment | `src/tunnel/profile.ts`, `setup-ui.ts`, `background-manager.ts` |
| Binding closed schema/opt-ins | `src/host/mcp-binding-config.ts`, `src/control/mcp/` |
| Generation/Store/Exchange consistency | `src/tunnel/{managed-binding,messaging-config,setup}.ts` |
| Tool arguments/ACK metadata/status | `pi-extension/index.ts`, Host port, extension-ack / messaging-ack tests |
| Support/acceptance boundaries | [README](../README.md), isolated tests and separate manual acceptance; public docs omit raw messages/Sessions/logs |

Historical plans/audits/validation reports retain their dated scope and are not current completion promises. Record code/configuration conflicts as limitations and separate implementation work; documentation changes do not alter runtime or frozen contracts.
