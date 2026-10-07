# DH-0 — Residency and Non-Amplification Contract

**Status: frozen architecture contract — HANDOFF 58241.** Research input:
HANDOFF 41726, `DH-RESEARCH: ADOPT-WITH-CHANGES`. This is a normative extension
of [DESIGN.md](../DESIGN.md), not a replacement constitution. It freezes design
requirements and future acceptance predicates, **not a claim that DH-1 controls
are implemented**. Current-source observations below refer to baseline
`f3bec7ade5a012374c2a0ae3bf450374795a8fe0`, Pi 1.0.2, pi-subagents 0.70.0.

## Invariant and vocabulary

**Durable ≠ Resident.** Durability is a persistence property, not a residency
requirement. Wayforge-owned resident memory must scale primarily with the active
working set and bounded recovery/control metadata, not approximately with total
durable history or historical payload bytes. Wayforge must not amplify host-owned
history through cumulative tool responses, duplicate resident caches, or
unnecessary payload copies.

This is a direction with measurable acceptance requirements, not constant RSS,
zero allocation, or a guarantee about Pi's total process memory. Serialization,
workspace hashing, bounded current projections, and explicitly scoped payload
materialization can require temporary copies. They require aggregate budgets and
release/lifetime definitions; a transient label alone is not a size bound.

- **Bounded active working set:** data required by currently admitted work with
  explicit count/byte ceilings and lifetimes, not all data for a task's lifetime.
- **Bounded per-record metadata:** finite schema/list/string bounds for one
  record; says nothing about the number of records loaded together.
- **Bounded aggregate resident state:** the sum of live records, indexes, caches,
  in-flight work, projections and retained copies has an explicit budget.
- **Persistent cold history:** retained history that is not implicitly eagerly
  materialized by normal current-task operations.
- **External payload bytes:** tool/model/artifact/file content outside core
  authority metadata; materialization needs a declared consumer and lifetime.

The following distinctions are mandatory in design and review:
**redacted ≠ bounded; bounded per item ≠ bounded aggregate; persisted ≠ resident;
reference ≠ payload copy; compacted context ≠ released memory.**

## Ownership model

These permissions describe the target architecture. The current gaps are listed
separately; permission to persist is not permission to expose private data.

| Category | May persist? | May remain resident? | May grow historically? | Arbitrary payload bytes? | May enter Pi-facing results? |
| --- | --- | --- | --- | --- | --- |
| Pi-owned session/runtime | Pi decides | Pi decides; Wayforge cannot enforce eviction | Pi decides | Pi permits text/images/tool content | Already Pi-owned; Wayforge must not echo history cumulatively |
| Wayforge active runtime | Only through an owning durable/diagnostic projection; never serialize live handles | Yes, within active aggregate budgets and lifetimes | No implicit live-history growth | Only explicitly bounded, scoped current materialization | Bounded current summaries/control metadata, not cumulative history |
| Wayforge authoritative durable state | Yes, exact existing schema/codec | Current task and bounded scan/page metadata only | Task catalog may grow; each task keeps current + previous snapshot | No arbitrary payload; bounded summaries are metadata, not opaque payload containers | Sanitized whitelist projections with aggregate budgets |
| Wayforge diagnostics/history | Yes, minimized diagnostic facts under explicit retention policy | Bounded current window/index; cold remainder not eagerly cached | Yes, with retention/quota policy; never authority | No unrestricted raw payload; sanitize and budget individual records | Bounded summary/page/reference only; no full cumulative event dump |
| External/tool/artifact payload | Owning tool/artifact policy decides | Explicit current consumer, byte budget, release point | Owner defines retention; not an implicit Wayforge cache | Yes under owner privacy/integrity rules | Only through approved bounded summary/reference or scoped byte budget |

Wayforge owns active runtime collections, authoritative snapshots, diagnostic
projections, and its emissions into Pi. Pi owns session retention, context
projection, provider transport and new continuation sessions; pi-subagents owns
child-session lifecycle/artifacts. DH does not transfer those capabilities.

## Non-amplification rules

1. A historical record must not be replayed in every current status, tool response,
   Advisor prompt, worker result or continuation prompt merely because it exists.
2. Each Wayforge boundary must declare its aggregate serialized UTF-8 byte budget,
   count budget where applicable, materialization scope, owner and release point.
   Character/token limits alone do not establish a serialized byte ceiling.
3. Full cumulative live event/status serialization is a known gap, not a valid
   bounded working-set design. Diagnostic status must describe current state;
   historical events belong behind a bounded page/window/reference boundary.
4. Repeated inspection of fixed current state must not cause response size to
   grow with unrelated history. Bounded pages may be requested explicitly, but
   must not accumulate in a Wayforge resident cache or be auto-replayed.
5. Worker prose is data, never completion authority. Summaries/references may
   replace large final text only under a later approved behavioral contract;
   they must preserve access to necessary evidence without replaying payloads.
6. Redaction is privacy filtering, not byte/count enforcement. `extra`, recursive
   redaction and parser input need budgets **before** avoidable cloning, joining,
   serialization or parsing; accepted-output bounds do not bound parser ingress.
7. Continuation must use bounded current authority/recovery metadata and fresh
   workspace verification, not historical Pi transcripts or diagnostic logs.
8. Copies needed for isolation/integrity are justified only with measured maximum
   simultaneous residency and lifetimes. Reference resolution must not silently
   hydrate entire history. No second completion/recovery/health authority.

## Core metadata versus payload

**Core Durable Metadata** may contain bounded identity, authority, state, digests,
references, summaries and recovery metadata. The existing
[schema/codec](../src/durable/state.ts), [store](../src/durable/filesystem-task-store.ts)
and [completion authority](../src/completion/completion-authority.ts) remain the
compliant baseline: exact allowlists, bounded lists/strings, current plus previous
snapshot, reference/digest evidence and write-once review facts. The 2 MiB store
read ceiling is per snapshot, not a catalog residency limit.

Core metadata must not become an arbitrary image/base64/screenshot/binary,
stdout/stderr, diff, raw tool-result, provider-body or transcript container.
A digest or bounded preview is not permission to hide a payload in a summary.
Workspace contents are hashed, not retained in core state. Secret rejection is a
guard, not proof that arbitrary text is safe; existing privacy rules still apply.

Future payload retention requires a separate reference boundary preserving stable
identity, integrity digest, media type, byte length and resolvable storage identity,
with an optional bounded preview. Resolution must verify identity/integrity and
handle missing, corrupt or expired content explicitly without granting authority.
DH-0 defines no `ArtifactRef` type, storage backend, schema field, migration, CAS
store, retention implementation or artifact garbage collector.

## Production projection inventory and required budget dimensions

Classification: **currently bounded** means the full supported normal projection
has finite source bounds; **bounded per item only** does not bound aggregate
history; **unbounded aggregate** and **unbounded payload** name observed missing
ceilings; **unknown** means no enforceable bound was proven. Every row is a future
budget obligation unless a reasoned exemption is stated. DH-1 must select numeric
UTF-8 byte/count ceilings and overflow semantics; DH-0 invents no runtime limits.

Tool rows are checked against production registration by the
[inventory coverage test](../test/dh0-architecture-contract.test.ts).

| Tool | Current classification and source | Required future budget dimension |
| --- | --- | --- |
| `wayforge_task_status` | No ID: **unbounded aggregate**, full live snapshot/events. With ID: **currently bounded** single durable whitelist detail. [Tools](../src/runtime/extension-tools.ts), [snapshot](../src/workflow/workflow-state.ts), [inspection](../src/durable/inspection.ts). | Aggregate UTF-8 response bytes; live list/window counts and summary/reference; explicit worst-case serialized-byte derivation for single-record detail |
| `wayforge_tasks` | **Bounded per item only / unbounded aggregate**; store loads every task, inspection maps/sorts all summaries. [Inspection](../src/durable/inspection.ts). | Page count + aggregate bytes + stable cursor/order; bound source materialization, not just the final array |
| `wayforge_delegate_workers` | **Unbounded payload**; 1–4 prompts with uncapped strings; full final text returned. Structured `unknown` result is resident but not returned by this tool. [Worker adapter](../src/adapters/pi-subagent-worker-adapter.ts). | Aggregate prompt and result bytes, per-call count, bounded summary/reference, scoped in-flight result residency |
| `wayforge_advise` | Governed refusal: **currently bounded** on normal path. Accepted non-governed verdict: **currently bounded** after parser, but raw response ingress is **unbounded payload / unknown** externally. [Advisor](../src/adapters/pi-advisor-adapter.ts), [controller](../src/workflow/workflow-controller.ts). | Verdict/envelope byte derivation; pre-parse/join input byte ceiling; preserve governed refusal and one-shot semantics |
| `wayforge_record_validation` | Success acknowledgment: **currently bounded**, name ≤200 chars. Input summary ≤1,000; durable summary ≤300. Live validation history is **unbounded aggregate**. [Tools](../src/runtime/extension-tools.ts). | Aggregate input/acknowledgment bytes, current validation count/lifetime; no raw command output |
| `wayforge_complete` | Success summary: **currently bounded** on authority path; typed failure envelopes need generic budget auditing. [Authority](../src/completion/completion-authority.ts). | Summary/envelope byte derivation; preserve candidate binding, readiness, one-shot judgment, lease/CAS and publication ordering |
| `wayforge_cancel` | Success `{ok,cancelled}`: **currently bounded**, fixed scalar shape. [Tools](../src/runtime/extension-tools.ts). | Justified exemption from pagination/reference: fixed acknowledgment with derived serialized byte bound; generic refusals still audited |

Other production boundaries must not disappear from the tool-only check:

| Projection/ingress | Current classification and evidence | Required future budget dimension |
| --- | --- | --- |
| Shared `toolResult` / refusals / failures | **Unknown** generic `unknown` payload and recursive redaction; typed failures may contain wider scalar metadata. [Tools](../src/runtime/extension-tools.ts), [redaction](../src/trace/redaction.ts). | Aggregate envelope bytes, metadata keys/string bounds; sanitized overflow semantics; no raw errors |
| Advisor evidence → Pi nested prompt | Major fields **currently bounded**; `extra` **unbounded payload** at helper seam. Current completion extra is fixed scalar data. [Evidence](../src/workflow/advisor-evidence.ts). | Aggregate evidence bytes, extra keys/items/bytes before redaction/serialization; summary/reference |
| Pi Advisor response → Wayforge parser | **Unbounded payload / unknown** provider ingress; joined text and `JSON.parse` precede accepted-field caps; rejection diagnostics can parse again. [Adapter](../src/runtime/pi-compatibility-adapter.ts), [parser](../src/adapters/pi-advisor-adapter.ts). | Raw/joined/pre-parse bytes, simultaneous copies, diagnostic parse reuse; token allowance is not a byte ceiling |
| Continuation package → fresh Pi prompt | **Currently bounded** for valid durable state + verified bounded workspace; no historical transcript. [Package](../src/recovery/continuation.ts), [launcher](../src/runtime/pi-continuation-launcher.ts). | Derived aggregate UTF-8 prompt/package ceiling and count bounds; retain fresh/stale evidence semantics |
| Governed-entry messages → Pi user message | Objective **currently bounded** after valid admission; images forwarded opaquely are **unknown** Pi-owned payload. [Entry](../src/extension.ts). | Text/envelope bytes; document image ownership and one-time forwarding exemption from local duplication, not from Pi retention risk |
| Events/status → diagnostic sink | **Unbounded aggregate** events and cumulative status; event detail **unbounded payload**, redacted only. [Log](../src/workflow/events.ts), [sink](../src/runtime/workflow-disk-sink.ts). | Per-event bytes; resident window/count; current status bytes; disk quota/retention; bounded explicit historical inspection |
| Startup/admission task enumeration | **Unbounded aggregate**; all-task scans are internal, not inherently Pi-facing, but source residency feeds projections. [Scanner](../src/recovery/startup-recovery-scan.ts), [wakeup](../src/recovery/wakeup-service.ts), [entry](../src/extension.ts). | Bounded index/page materialization and scan concurrency; total scan work may remain O(task count), resident snapshots may not |
| Command/UI notifications → Pi presentation | Session-status text is **currently bounded** by admitted IDs/fixed text, but reading status materializes a full snapshot; startup/error notifications are **unknown** where raw `Error.message` is interpolated. [Entry](../src/extension.ts). | Aggregate notification bytes and sanitized errors; current-state accessor without cumulative snapshot copies; no exemption for unbounded error strings |

Repeated bounded emissions will still grow Pi's canonical transcript. DH promises
no cumulative Wayforge amplification, not zero host history growth per operation.
No exemption permits unlimited payload copying; exemptions must name owner,
shape, maximum size/copy count and lifetime, and explain why pagination/reference
is unnecessary. New projections require inventory and review updates.

## Active working set

Active means necessary for an admitted current operation or authority decision:

- current task identity/control state, policy and current attempt/invocation;
- bounded recent recovery/failure state and current lease/continuation intent;
- currently required child/route state, pending-work count/epoch and current
  runtime-private eligibility/cooldown information;
- current workspace fingerprints and fresh/stale validation/completion evidence
  required by existing readiness and fencing rules;
- bounded current Advisor evidence/verdict/one-shot claim; and
- explicitly requested referenced payload currently being consumed within its
  byte/concurrency budget, with an end-of-use release point.

A suspended task's necessary scheduling/index metadata can be active, not every
historical snapshot. Current-task membership alone does not make every past child,
route, validation, event or finding active. Unrelated tasks/events/payloads are
cold unless explicitly inspected in a bounded operation. DH-1 must specify
per-category numeric caps and eviction/summarization lifetimes; authority-required
facts must not be discarded simply to meet a cap.

## Cold history and recovery

Settled child/route/event records, superseded validation observations, diagnostic
history, unrelated tasks and no-longer-used payloads may become cold. Preserve
recoverability under the owner's retention contract; cold does not mean deleted.
Historical inspection may lazily read bounded pages or individual references.

Authority-critical current facts must survive: task identity/status/revision,
lease generation, workspace identity/digests, validation freshness, completion
candidate/verdict binding, negative-review fact, suspension/counters, and persisted
continuation launch intent/ambiguity. Preserve integrity identifiers and explicit
unknown/missing/stale outcomes. Historical diagnostic records never become a
substitute source of authority, health or review allowance.

Recovery continues to use current bounded task metadata and fresh workspace
verification, not historical payload bytes, failed streams, old Pi transcripts or
diagnostic event logs. Workspace verification may stream current file bytes for
hashing; that is not materializing historical payloads. Existing structured
checkpoint fields are initialized but not an automatic progress transcript at this
baseline. DH-0 neither improves nor claims general cross-session governed Main
resume: it preserves the existing new-invocation continuation contract.

## Compaction semantics

**Pi context compaction ≠ durable-history deletion ≠ resident-memory release.**
Pinned Pi's SessionManager retains canonical entries/indexes while compaction
reduces the active context projection. See upstream
[#6841](https://github.com/earendil-works/pi/issues/6841) and
[#9613](https://github.com/earendil-works/pi/issues/9613).
Wayforge must not infer eviction, deletion, liveness or authority from compaction.
Correctness must remain independent of direct access to old Pi transcript entries;
a continuation uses a fresh in-memory Pi session. No Pi fork/workaround is added.

## Acceptance predicates (future behavioral enforcement)

Use fixed active-set fixtures and independently vary historical record count H and
external payload bytes P. Record serialized UTF-8 bytes, category counts, copy
lifetimes, latency and post-GC heap when meaningful. Before running acceptance,
DH-1 must publish numeric budgets, sample sizes, noise tolerance and slope allowance
for each owned boundary; do not choose thresholds after seeing results.

| Predicate | Testable acceptance and current status |
| --- | --- |
| Payload non-ingress | For fixed bounded metadata/reference/preview, increasing P must not increase authoritative serialized bytes proportionally to P. Forbidden payload fields fail codec validation; digest changes fit the same envelope. Existing codec defenses stand; expanded size-sweep coverage is future work. |
| Single-task resume | Instrument reads/materializations: one task continuation reads its current snapshot and current workspace, not unrelated cold task snapshots or historical payload bytes. Catalog discovery may traverse a bounded metadata index/page. Current all-task startup enumeration is a known gap; fresh continuation already excludes failed transcripts. |
| Working-set scaling | For fixed active set, post-settlement Wayforge control counts/bytes remain within aggregate category budgets as H/P grow; fitted control-state growth per historical payload byte must stay within predeclared near-zero/noise allowance, not approximate payload proportionality. Temporary hashing/materialization peaks are separately budgeted. Current live-history arrays do not pass yet. |
| Pi-facing projections | Every production projection has aggregate byte/count budget, pagination/reference boundary or reasoned exemption. Test exact UTF-8 serialized bytes with Unicode/escaping and boundary/overflow cases, not only character count. Inventory coverage is mechanically checked now; behavioral budgets remain DH-1. |
| Non-amplification | With fixed current state, repeated status/Advisor/continuation/result generation does not include cumulative historical payload/events; per-response bytes stay inside declared budgets independent of H/P. Explicit historical pages do not create an unbounded resident cache. Current live status is a known gap. |
| Compaction | Context-message reduction never counts as eviction evidence. Separately measure canonical resident history/materialized payloads; verify recovery/completion without prior transcript access. Pi eviction acceptance is upstream-dependent. |
| Authority preservation | Cold/reference paths preserve readiness, freshness, workspace/candidate binding, lease/CAS, one-shot review, negative-review semantics and ambiguity blocking. Missing/corrupt references cannot manufacture approval or recovery authorization. |

No machine-specific RSS constant is an acceptance criterion. Source-owned
collection/serialization metrics are primary; isolated post-GC heap and fitted
slope characterize allocations; RSS is secondary/noisy and includes host state.

## Regression and characterization plan

- **Unit:** codec payload rejection and fixed-metadata payload-size sweeps;
  byte/count boundary tests including Unicode/JSON escaping; pre-parse/extra/
  redaction limits; reference summary independence; inventory coverage. Existing
  [codec tests](../test/durable-state.test.ts) and
  [continuation tests](../test/continuation.test.ts) prove current defenses, not DH-1.
- **Integration:** repeated live status and many historical tasks; instrument
  single-task recovery reads; worker result summary/reference semantics; reference
  integrity/missing/stale outcomes; unchanged completion and negative-review
  authority. Existing [authority tests](../test/durable-completion-authority.test.ts)
  and [launcher tests](../test/pi-continuation-launcher.test.ts) remain required.
- **Characterization:** vary H at 10/100/1,000/10,000 and conservative P tiers with
  a fixed active set; isolate loader processes, baseline/settlement measurements,
  post-GC heap where supported, resume latency, snapshot/tool bytes, simultaneous
  copies and growth slope. Repeat to estimate noise; do not escalate toward OOM.
- **Stress:** bounded long histories, repeated inspection, many completed tasks
  with one active task, large synthetic text/image references, constrained heap,
  scan pagination/concurrency and artifact resolution. Use temporary isolated
  data, no production profile, credentials or real sensitive payloads.
- **Upstream-dependent:** Pi lazy session reconstruction/cold-entry release,
  inline-image externalization, active-image materialization and restored-image
  rendering. Passing Wayforge checks does not certify those capabilities.

Research 41726 measured synthetic Pi resume with 10/100/500 × 64 KiB inline
payloads: approximately 0.67/6.60/33.00 MB heap increase; after synthetic compaction
all original entries remained resident while context had two messages. Wayforge
10/100/1,000/10,000 event snapshots were approximately 1.6 KB/12.4 KB/122 KB/1.24 MB;
10,000 events used approximately 3.28 MB heap after snapshot materialization.
These are accepted characterization observations, **not rerun DH-0 measurements,
portable thresholds, or independent proof of a particular RSS multiplier**.

## Architecture relationship, roadmap and scope

**DH is independent of TR3. DH is independent of 1B.4B.** Those labels do not
supply DH authority or sequencing dependencies; the baseline freezes TR0/TR1/TR2
and 1B.4A. Existing authoritative durable-state architecture remains valid.
DH-0 does not reopen frozen runtime contracts. No direct contradiction was found.
If later enforcement contradicts one, STOP and use explicit reopening, not silent
contract replacement. Budget enforcement must not replenish authoritative review,
change post-generation overdraw verdict validity or authorize Worker replay.

- **DH-0 (this freeze):** ownership, residency/non-amplification requirements,
  projection inventory, active/cold boundaries, acceptance predicates and honest
  inventory checks. No runtime enforcement claim.
- **DH-1 (separate authorization):** runtime event/child/route/validation/failure/
  unresolved/finding lifetimes; bounded current status; task inspection pagination
  and bounded discovery materialization; worker prompt/result projection; Advisor
  pre-parse/extra/redaction bounds; diagnostic quotas; concrete budgets, overflow
  semantics and the above regression/characterization gates.
- **DH-2 (deferred):** reference/storage/lifetime/integrity implementation only
  when justified; upstream Pi lazy history and payload externalization tracked
  under their actual owner. No backend decision is made here.

DH-0 changes documentation and test-only coverage. It does not change status,
event retention, truncation, pagination, startup scanning, Advisor transport,
artifact storage, resume, Pi sessions, packages/profiles or durable schema.

## Mechanical evidence and limits

The test discovers production `defineTool` registrations with TypeScript's AST,
requires each in the tool table exactly once, checks the DESIGN entry link and
resolvable local evidence/test paths. Its RED is the absent contract; GREEN is the
smallest documentation addition. A newly registered/renamed tool missing from the
inventory fails independently of prose constants. It does not verify prose
truthfulness, semantic budgets, non-tool completeness, fragment anchors or memory
bounds. Those remain source-backed four-lane review and future behavioral tests;
no tautological constants are offered as residency enforcement.

Validation follows [CONTRIBUTING.md](../CONTRIBUTING.md): full package tests,
typecheck/build, architecture/Alpha 0/Alpha 1 gates, repository workspace and format
checks. No operational runtime dogfood is claimed for this documentation freeze.
