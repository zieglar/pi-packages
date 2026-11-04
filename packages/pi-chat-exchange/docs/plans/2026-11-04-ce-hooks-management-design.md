# Hooks management: blocked design and verified boundaries

Handoff: `HANDOFF-CE-HOOKS-MANAGEMENT-01`. Revision: **R2**.
Status: **BLOCKED_AT_DESIGN_GATE; no management feature implemented**.
Baseline: `894ea9eddd88841fa667748cda7af98815b99785`.
Worktree: `/Users/zieglar/Code/pi-packages-ce-hooks-management-01`.
Branch: `feat/ce-hooks-management-01`.

The source delta contains this proposal and six characterization cases in two test files. Runtime code, production configuration and installed packages are unchanged. No commit, merge, push, release or production transport operation is authorized or performed.

## Goal and ownership

Provide operator-only list, add, edit, enable, disable, remove and explicit harmless fixture testing. Preserve `ce.message.committed.v1`, metadata-only stdin, fixed local command/arguments, sender ownership, existing execution semantics and Connect's Hooks-off default.

| Direction | Rule owner | Recipient |
|---|---|---|
| ChatGPT → current Pi | MCP sender binding `config.hooks` | Current Pi's exact registered Endpoint |
| Current Pi → ChatGPT | Current native Session registration's `hooks` | Exact `manifest.chatgptEndpoint` |

Pi `/ce-hooks` currently audits loaded outbound rules only. Selected inbound configuration does not prove what an MCP process loaded. Configured, loaded, admitted and executed must remain separate facts. No MCP/model/message input can grant script execution or select a command.

## Existing mechanisms and their limits

- `src/tunnel/background-manager.ts:1765`: the real `withProfileConfigurationLock()` refuses running, pending, uncertain and external transport. It authorizes Profile configuration work only; it does not stop/start transport or fence independent Pi live-policy writers.
- `src/tunnel/messaging-config.ts:160`: `publishMessagingGeneration()` stages an immutable digest-paired binding/sidecar. It is not a Profile activation API, live-policy transaction or registration grant.
- `src/tunnel/live-session-migration.ts:98`: existing activation pattern is an exclusive temporary file, fsync, final guard/Profile revision check and one rename. Unknown activation durability never authorizes automatic retry or rollback.
- Same-ref inbound candidate publication is format-compatible: a new MCP binding with different `config.hooks` can retain the exact live policy reference and chain. Existing readers/composition accept the candidate. This demonstrates reusable format machinery, not safe consent-to-adoption binding or a completed production publisher.
- Non-live `createMultiSessionRegistration().register()` already accepts Hook arrays; omission preserves and `[]` clears. It cannot operate on the selected live profile.
- `src/tunnel/live-session-policy.ts:15-16,76-107,136`: live intent/registration schemas do not accept Hook changes; transformations preserve Hooks; readers recompute permitted parent→child transitions. Recomputed digests do not make a new transition valid.
- `migrate-live` reads a legacy source (`live-session-migration.ts:109`) and refuses an existing live source. `initializeLivePolicy()` initializes genesis generations to zero and presence disclosure to false (`live-session-policy.ts:186-189`). It is not a safe update or continuity-preserving migration of current history.
- Approved live design fixes launch Hooks independently of registration consent (`docs/plans/2026-11-03-ce-live-admission-design.md:31-39,165`); operations guidance reserves history migration for independent review preserving facts, tombstones, epochs and permission generations (`docs/live-session-connect.md:44`). No evidence establishes a ban on editing every line of these files; the boundary is the specific authority/compatibility contract.

## Security finding: confirmation must survive through adoption

The earlier security review returned **REWORK** for a concrete medium-severity design gap. The finding remains unresolved by the current runtime format. A prompt warning, an extra pre-rename read or a UI indication is not a fix.

A rule contains only the recipient adapter/Endpoint, not the registration incarnation. `createLiveMcpComposition()` captures a registration when the process starts; `hookAllowed()` subsequently checks that loaded registration against current status/runtimeSessionId/epoch (`src/tunnel/live-mcp-composition.ts:32,49-54`). It never compares with the incarnation confirmed when the candidate was authored.

Two schedules matter:

1. After the last policy/target check, an independent Pi writer can revoke and reauthorize the target while the STOPPED Profile lock is held. Profile activation and live-policy publication have no common transaction or writer fence. A pre-rename reread catches changes before that read, not commits after it.
2. After candidate save or activation but before MCP adoption, the same revoke/reauthorize can advance the epoch. A fresh MCP composition then accepts the Endpoint-scoped rule for that new epoch. An already-loaded composition correctly denies after the epoch change; that denial does not constrain a later fresh load.

The new tests reproduce these schedules deterministically using real public live-policy operations, the real Profile lock and the real composition admission method. They do not launch a Hook or implement/validate a production activation transaction. The candidate-save case stages and reads back immutable files while leaving the Profile unchanged; it represents the adoption gap without claiming to exercise a nonexistent management publisher.

**Required refusal:** no new enabled live inbound rule, executable-changing edit or disabled→enabled publication may proceed under a promise of confirmation-time incarnation binding with only the current same-ref publisher. A check that cannot remain enforceable through adoption must refuse the operation. Disabled drafts may remain inert; drafts are not grants or proof of load. Do not quietly broaden consent to future incarnations or treat a warning as operator acceptance of that broader authority.

To support the promised scope, a separately reviewed design must either persist and enforce the confirmed policy/registration identity at adoption and each start, or provide verifiable writer coordination lasting through the relevant adoption boundary. It must cover independent Pi writers and queued Hook starts; STOPPED transport alone is insufficient. This document does not claim a minimal correct amendment already exists or prescribe a new lock, per-rule field or version number before compatibility analysis.

## Second boundary: Pi messaging and reload continuity

`assertLiveRegistrationContinuity()` (`pi-extension/multi-session-runtime.ts:96`) requires the loaded/current Hook arrays to be identical. It is called for operation admission and reload transfer. `effectiveLiveRegistration()` uses it, and `PiSessionPolicy.registration()` also checks loaded Hooks (`pi-extension/live-session-runtime.ts:31-34`).

Consequently, adding a policy intent alone is insufficient: changed Hooks can deny ordinary messaging and same-Owner reload. A full amendment design must specify old and new factories, own versus unrelated Session changes, deny-only execution, in-flight work, transfer/drain, failed reload and ownership continuity. It must preserve read/ACK generations, tombstones and epoch authority; no takeover, Owner repair or implicit restart is introduced. The new runtime-guard case exercises unchanged snapshots, changed own Hooks and an unrelated Session change; it does not claim the current chain can publish the synthetic changed snapshot or that a real reload lifecycle was tested.

## Alternatives requiring a scope decision

### A. Reduced authoring/inspection delivery

An operator-only `/ce-hooks` manager can distinguish directions, show configured versus loaded state, validate local rules and prepare disabled drafts/candidates. Live Pi mutations remain unsupported. Enabled inbound publication also remains refused until the adoption-binding requirement above has a reviewed solution. This is useful preparation, but does not fulfill active ChatGPT → Pi notifications or full CRUD. It must not be presented as the requested completed feature.

### B. Narrow compatibility amendment design (recommended)

Keep the requested active notification and two-sender goal. Authorize a bounded design for (1) live Pi Hook mutation with runtime/reload continuity and (2) inbound confirmation-to-adoption incarnation binding. Prefer additive, explicitly selected compatibility handling and existing publication primitives where sufficient. Specify old-reader refusal/upgrade behavior, exact expected-tip confirmation, uncertainty reconciliation, preservation of unrelated facts and no expansion by an old loaded process.

This requests authority to design the necessary amendment, not to deploy it or to implement an unreviewed new protocol. Do not simply append a new intent to the current format and assume existing readers accept it. A separately reviewed offline migration is another possible design, but recreating genesis, downgrading to legacy or editing content-addressed files in place is rejected.

## Shared UX and validation requirements for a future approved design

- Keep `/ce-hooks` status/list compatible and expose plain-language sender directions. Current native Session determines the exact target; no latest-Session or `pi/main` fallback. Scope local configuration views to that target; do not expose other Sessions' private grants.
- Reuse `parseHookRules()` and recipient-policy validation at the input boundary. Executable paths are normalized absolute paths, arguments are a fixed JSON array, timeout is bounded, IDs are unique and drafts default to disabled. Sanitize all terminal text. No shell interpolation, script-content preview, credential read or remote command selection.
- Native TUI confirmation shows the exact direction, target, rule and execution delta. Bind it to Session/environment/cancellation, Profile bytes, policy identity and intended registration tuple. Stale confirmation refuses without rebase or retry. These checks are necessary but insufficient to close the cross-writer/adoption gap by themselves.
- Publish only complete validated candidates under existing locks, retain prior immutable generations, perform one activation commit and report uncertainty truthfully. No automatic Tunnel lifecycle or grants on list, configure, save, reload or Connect.
- Explicit fixture testing runs only a fixed package-owned harmless fixture in a private temporary directory with synthetic metadata and no real Message. It is labeled “Test built-in notification fixture”, not “Test this script”. Never use the selected personal executable or production payload. It cannot prove delivery, ACK, task completion or compatibility of the user's script.
- Tests must cover CRUD validation/confirmation/cancellation, no writes or process execution during list/config, exact Endpoint boundaries, STOPPED/external refusal, metadata-only stdin, timeout/failure, uncertain commits, restart/adoption, no startup replay, both security-review schedules, and own/unrelated-Session reload continuity. Acceptance requires a fixed-target security review of actual implementation.

## Characterization and verification record

The two test files add six cases:

- `test/tunnel/live-session-migration.test.ts`: same-ref inbound candidate compatibility and old-process non-expansion; live registration rejects `hooks` without chain writes; repeat legacy→live migration refuses without writes.
- `test/tunnel/hooks-management-characterization.test.ts`: revoke/reauthorize after a final check while the Profile lock is held; revoke/reauthorize after candidate save before adoption; own Hook changes deny the actual runtime continuity/effective-registration guards while unrelated Session changes preserve own continuity.

R2 verification under Node 24.21.0 passed: ten selected files, **104/104 tests**, and package typecheck (`tsc --noEmit -p tsconfig.json`, exit 0). Logs: `/tmp/ce-hooks-management-01-r2-suite.log` and `/tmp/ce-hooks-management-01-r2-typecheck.log`. Build passed on the unchanged production baseline earlier. No UI, production activation, real reload lifecycle, personal script or live peer was tested. Direct local Vitest/TypeScript entrypoints avoid pnpm's unsuccessful pre-script dependency reinstall against temporary symlinked dependencies. No fresh dependency installation is claimed.

## Review record and freeze rule

The first security review returned REWORK for the adoption gap. The first plan review returned BLOCKED because this parent changed the fixed document before review completion. Its original-snapshot analysis supported the main format and live-Pi boundary findings and added the runtime-continuity requirement. Neither result is a PASS for this revision. R2 accepts both findings and does not declare the security gap closed.

Before resubmission, fix the exact three-file review set and SHA-256 hashes, finish verification, remove temporary dependency links and record source baseline/status. While either reviewer is running, make no target edits or dependency-link changes. Reviewer results and final verification belong in a separate report after both finish; they must not be appended to this frozen document mid-review. A favorable review of this blocked-design report is not implementation, production approval or permission to waive the unresolved gate.

## Decision needed after fixed-target review

The original implementation goal remains blocked by the two contract boundaries above. Choose reduced authoring/inspection scope A, or authorize bounded amendment design B to preserve the active notification and full two-sender goal. No architecture change, safety waiver, production configuration, install, script execution, transport operation, commit or release is inferred from silence or this report.
