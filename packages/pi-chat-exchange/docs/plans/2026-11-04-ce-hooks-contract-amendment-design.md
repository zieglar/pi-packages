# Hooks management: two bounded contract amendments

Handoff: `HANDOFF-CE-HOOKS-MANAGEMENT-01` (continuation). Revision **D1**.
Status: **REVIEW_REQUIRED — design only, implementation not authorized this round**.
Source baseline: `894ea9eddd88841fa667748cda7af98815b99785`.
Workspace: `/Users/zieglar/Code/pi-packages-ce-hooks-management-01`.

This document addresses only the two gates established by the fixed R2 report: inbound consent-to-adoption binding and outbound Pi messaging/reload continuity. R2's reviewed files and report remain unchanged. No implementation or test code, production configuration, Store, Owner, installation or transport is changed; no scripts/tests or Git commits are executed in this design round. The previous 104-test result characterizes the old behavior, not these amendments.

## 1. Scope, authority and selected alternative

Reuse the existing immutable live history, expected-tip exclusive-link commit, intent locators, immutable binding/sidecar writer, STOPPED Profile configuration lock, single Profile rename, runtime admission callback and official reload/mutex transfer. Add no Store schema, protocol entity, capability, Owner/lease transition, execution event, polling loop or new command framework. Keep `ce.message.committed.v1`, metadata-only stdin, static local commands, bounded runner behavior, no replay and Connect's Hooks-off default.

| Direction | Executable rule source | Additional consent fact |
|---|---|---|
| ChatGPT → Pi | Operator-controlled MCP sender binding `config.hooks` | MCP-sender consent in the versioned live chain, binding one exact immutable binding generation to confirmed target incarnations |
| Pi → ChatGPT | Sending Pi registration's existing `hooks` array | A per-registration Hook generation in the versioned live chain |

Receiving Pi `registration.hooks` is never an inbound allowlist. The operator's native TUI remains the only grant writer; model tools, MCP calls, message text and project configuration cannot publish Hook authority. A chain consent fact is private configuration authority, not a CE capability or a second Endpoint registry.

Alternatives considered:

1. **Selected: sender-scoped consent facts and Hook generations in an explicitly selected successor live format.** One exclusive chain commit binds targets and approval together. Immutable sender configuration remains the executable ceiling. Runtime checks the consent before every actual child start; no cross-file atomic transaction is claimed.
2. Static consent fields only in binding plus a new cross-writer lock. Persisted target tuples can help, but narrowing/ABA, all Pi writers, interrupted activation and adoption still need coordination. A new lock protocol is larger than reusing the existing exclusive chain commit and creates another recovery boundary.
3. Profile rereads, a warning, genesis recreation or in-place edits. Rejected: rereads do not close the later race, warnings do not grant a changed scope, and rewriting history loses existing revocation/generation evidence.

The amendment changes private configuration parsing, allowed live transitions and Hook admission/continuity for the new mode. It does not silently relax v1. The lifecycle upgrade described below is part of this same Handoff's future implementation, not a new task or production authorization.

## 2. Minimal versioned data model

Use new closed kinds `ce-live-session-v2` and `ce-live-launch-v2`. The MCP binding's existing outer version can remain 1: its explicitly new admission-policy kind and reference fields already make old parsers refuse. Do not globally accept unknown fields or change `CeHookRule`/event/stdin schemas.

A v2 reference pins `profilePath`, existing canonical `root`, existing `policyId`, existing `genesisDigest`, and `upgradeSequence`, in addition to `kind`. It points to the **same immutable history**, not a new genesis. The first v2 envelope at `upgradeSequence` is a validated upgrade marker; the prior contiguous v1 prefix is validated with its original rules. Once v2 begins, later v1 envelopes are invalid. Existing limits on files, history bytes, slots and intent locators remain; exhaustion refuses without compaction.

Two additions to the v2 snapshot are sufficient:

- Each registration gains `hookGeneration`, initially the upgrade marker's sequence. Only its authorized Hook-array mutation changes this field, to that mutation's chain sequence. Existing identity, status, epoch, read/ACK bits and generations, presence and Hook arrays retain their exact values at upgrade.
- A separate MCP-sender `mcpHookConsent` has `generation`, `bindingGeneration` (the existing immutable pair hash, or null when no consent exists), and bounded `targets`. Each target stores `ruleId`, exact Pi `endpointId`, trusted `runtimeSessionId` and `epoch`. Targets cover every enabled rule exactly once; disabled rules authorize no execution. At upgrade this record has the upgrade sequence, null binding and no targets: previously configured MCP rules gain no new consent implicitly.

The binding generation already commits to exact binding bytes, normalized rule bytes and launch sidecar. Do not duplicate commands, arguments, config/rule digests or entire manifests into the consent record. UI can derive and display a rule/config digest for review; the immutable pair hash is the durable scope identity. There is no self-reference: the launch sidecar references stable root/genesis/upgradeSequence, not a future consent-envelope digest. Thus the pair hash is computable before the consent commit.

New intents:

- `set-pi-hooks`: trusted actor native Session, its exact active endpoint/incarnation, and the complete validated replacement Hook array. Only its registration's Hooks and `hookGeneration` change. Omitted Hooks in ordinary register/reauthorize continue to mean preserve, never enable.
- `set-mcp-hooks`: trusted local operator actor, exact candidate binding generation and confirmed target tuples. Only `mcpHookConsent` changes; `generation` becomes this commit's sequence. It cannot change recipient registrations, read/ACK, identity or Pi outbound arrays. Validate candidate provenance, sender identity, unchanged global ceilings and complete enabled-rule coverage at the operator boundary and again at runtime against the immutable binding.

Both operations use the existing expected-tip publication and locator discipline. Every accepted Hook replacement, including disable, remove and a return to identical bytes, advances the relevant generation. Other registrations' Hook generations do not change. A no-op may be reported without publishing, but never treated as fresh authorization or recovery of a denied old runtime.

For an ordinary new v2 registration, initialize `hookGeneration` to that registration commit's sequence and use no Hooks unless separately authorized. Ordinary updates preserve Hook facts; explicit reauthorization preserves the array and Hook generation but changes epoch as today, so an old incarnation still cannot execute. The v2 transition validator has an explicit whitelist for each intent and checks bounded, nondecreasing generation values against the parent; only the relevant Hook intent can change its corresponding Hook facts. The v1 fixed-identity transform is retained for the v1 prefix; the v2 transform treats MCP consent as mutable sender state while keeping Store/Exchange/identity/global ceilings fixed. Do not relax the v1 `fixed()` check for all modes.

## 3. Inbound consent, publication and adoption

### 3.1 Consent scope and atomic authority commit

Capture the native Session/environment, exact selected Profile bytes/revision, v2 reference, expected chain tip, full candidate sender binding and target tuples. Parse once into typed values using existing bounded/private readers and `parseHookRules()`. Each enabled rule must address an exact active Pi registration in this policy and have an unambiguous confirmed tuple. Do not infer a new epoch from the same Endpoint label.

The native operator preview authorizes the **whole candidate MCP sender Hook set and configuration**, including exact executable/args, enabled changes, peer and target tuples. Because its binding identity changes as a unit, do not silently carry an approval for a different binding forward. An administration view may show that sender's complete candidate set to the local operator for confirmation; no new rule/grant enumeration is exposed through model or MCP tools, or to receiving peers. Pi outbound editing remains limited to its current native Session.

After acceptance:

1. Acquire the real STOPPED Profile lock. Refuse running/pending/uncertain/external transport; never stop it here. Revalidate Profile, Session/environment/cancellation, expected tip and confirmed target tuples. Stage the immutable pair and verify the bytes equal the previewed candidate.
2. Publish `set-mcp-hooks` with the captured expected tip. The exclusive next-slot link is the sole **consent linearization point**. A competing registration/reauthorization commit either wins that slot (the approval conflicts without rebase), or follows the consent commit (the recorded tuple remains old and will be denied). The Profile lock is not claimed to fence Pi writers.
3. Only after observed publication and normal durability checks may the existing single-rename Profile path select that exact candidate. Recheck original Profile bytes and lock integrity. An observed target change before rename refuses activation and reports published-but-inactive consent; it does not roll back the chain. An unobserved later change is still safely rejected at adoption/start.

Profile selection is deployment, not a grant. Before/after the chain commit, during the rename gap and after a crash, the checks below must enforce eligibility; there is no fictitious atomic chain/Profile transaction.

### 3.2 Eligibility at load and each actual start

The v2 MCP composition captures a Hook generation **only at factory/process load**, and only when all required checks succeed. An absent/disabled/stale consent captures no eligible generation; observing a new one later does not create eligibility.

For a particular loaded enabled rule, require all of:

- The actual verified loaded binding generation equals the chain's approved `bindingGeneration`; the exact selected Profile still resolves to that loaded immutable generation. Validate the complete pair using existing private no-follow/credential-alias-safe readers. A changed/unreadable selection denies Hooks, not an implicit fallback.
- The fixed sender endpoint, Store/Exchange, global ceilings and v2 reference pass existing composition checks. The executing rule is the exact normalized static rule in that binding; no command originates in the consent record or a remote event.
- Captured MCP Hook generation equals the current consent generation. The target tuple for this rule is present and equals both the composition's loaded registration and the current active registration: exact Endpoint, runtime Session and epoch.
- Event sender is exactly the configured MCP sender and recipient equals the static rule recipient. Recheck through the existing runner admission callback immediately before the actual child start, including queued work. No asynchronous gap or untrusted callback is inserted between that synchronous admission and direct spawn.

A candidate whose target changed before process adoption is inactive even in a new process: it cannot replace the confirmed tuple with its load-time epoch. A grant disabled then re-enabled with identical binding bytes has a new generation; the old process stays denied. Changing Profile selection or superseding consent also denies the old binding. These are Hook-only denials; valid existing messaging/renewal remains governed by its own authority. Malformed configuration/history retains existing fail-closed configuration behavior.

Fresh consent plus an explicit owning-process load is needed to gain eligibility. No automatic hot reload, replay, Owner recovery or transport restart is introduced. A child already admitted before revocation may finish, as today; queued/unstarted work must pass the new check. This is not revocation of external side effects or exactly-once execution.

Actual-start authorization linearizes at the final synchronous validated-policy read after dequeue, immediately before direct spawn. It is not atomic with an OS process start or another process's commit. If revocation completed before that read, the start is denied; a start admitted before a concurrent commit may still spawn/finish even if its OS start occurs later. This preserves existing admitted-before-revocation semantics and does not introduce a cross-process execution lock.

## 4. Outbound Hook updates without breaking messaging

For v2, split the current combined continuity condition into **message identity/permission continuity** and **Hook eligibility**. The v1 path retains its existing equality checks unchanged.

| Operation/state | v2 behavior after own Hook generation changes |
|---|---|
| Send, inbox, payload read, ACK, renew | Continue when existing Session/Endpoint/epoch/ref/Store/Exchange and independent permission generations admit them; Hook-array equality is not a message permission |
| Old loaded Hook runner | Deny all further starts when captured own `hookGeneration` differs; do not copy new rules into it |
| Unrelated Session | Its Hook generation, messaging and Owner remain unchanged |
| New factory after official reload | May capture the new approved array/generation only after normal identity/mapping/mutex checks |
| In-flight child or admitted message | May finish under existing semantics; no cancellation/replay promise |

Use a single per-registration generation, rather than per-rule state: any own array change conservatively suspends all old-runner starts until reload. This is an explicit minimal tradeoff; unchanged rules in that same array also pause. It avoids ABA revival and preserves unrelated Sessions.

Outbound execution additionally requires exact loaded/current identity and epoch, an enabled exact static rule in the captured array, and `loaded.hookGeneration === current.hookGeneration`; a missing generation is ineligible. Read one validated current snapshot per actual-start decision through the existing runner gate, with the same admission linearization as inbound. Ordinary message continuity never mutates the captured rule array or captured generation.

`set-pi-hooks` needs native confirmation of the full array and expected tip; publication itself does not create a new Host or Owner. The new messaging-continuity predicate must replace own-Hook equality at **all** v2 sites: normal `run()` admission, `effectiveLiveRegistration()`, pending-transfer consumption, transfer preparation, and `PiSessionPolicy.registration()`. Removing just one comparison is insufficient. Keep existing identity/epoch, failed-state latch, mapping equality, mutex ownership and read/ACK generation checks.

Official reload closes old admission/drains existing work through the established lifecycle. Transfer is allowed across Hook generations only for the same v2 policy identity, Session, Endpoint, epoch, Store/Exchange and unchanged mapping; unrelated or revoked identities refuse. The new factory reads the current policy and captures that exact generation; a concurrent later Hook update makes it immediately ineligible for Hooks without broadening any message permission. It never refreshes its captured Hook generation in place.

If reload fails after the old generation closed, report reload required/unavailable and retain existing fail-closed cleanup/mutex semantics. Do not revive the old runner, clear a failed latch, acquire another Owner or claim messages stayed available throughout failed reload. Before an explicit reload begins, a Hook-only publication does not interrupt otherwise authorized messaging. Presence, read/ACK and reauthorization remain independent, and Connect still adds no Hook grants.

## 5. Explicit compatibility transition, no genesis reset

The closed v1 transition cannot accept these intents. A future bounded **offline mode upgrade** is therefore necessary; it is not smuggled into Connect or ordinary Hook saving. Normal v1/legacy use is unchanged until explicitly upgraded. No production upgrade is performed or authorized by this document.

The upgrade reuses existing immutable history and next-slot CAS:

1. Require the real STOPPED Profile lock, explicit operator upgrade confirmation, exact Profile revision and v1 tip, compatible binaries, and reconciliation of unresolved old intents. Operator instructions close normal Pi bindings through their existing lifecycle; no tool implicitly stops transport, ends another Session or recovers ownership.
2. Compute the v2 reference with the expected next sequence as `upgradeSequence`. Stage a v2 launch pair referencing that same root/policyId/genesis. No future marker digest occurs in that pair, so it has no circular hash dependency.
3. Persist the existing kind of intent locator before publication. Its upgrade intent records the actor, old Profile revision and candidate binding generation needed for explicit reconciliation. Publish the unique v2 upgrade marker into the next slot using existing exclusive link/fsync. Its transition preserves every prior fact/tombstone/epoch/read/ACK generation/presence/Hook array, adds own Hook generations at this sequence and initializes empty MCP Hook consent. The reader validates a v1 prefix followed by exactly one upgrade marker and v2 successors.
4. After that commit, select the prepared v2 pair by the existing checked single Profile rename. Normal explicit load/start follows separately and requires the existing exact startup scope authorization because the binding changed. Inbound rules require new sender consent; migration does not fabricate it from a remembered selection or old enabled bits.

An in-flight conforming v1 writer races for the same next slot. If it wins, the upgrade conflicts without rebase. If the marker wins, an old reader encounters the unknown envelope and fails closed; a stale prepared writer cannot overwrite that slot. Thereafter it cannot append a valid v1 successor without reading an unsupported chain. This uses the existing commit barrier, not an unenforceable claim that the STOPPED lock freezes all Pi writers.

A surviving old process/Owner or an operation admitted before the marker is not revoked by the marker. Normal require-unowned/mapping/lease rules still decide new binding. If old cleanup is uncertain or an Owner remains, report not ready and require the existing separate operator cleanup; no automatic takeover. There is no uninterrupted-service promise across the explicit format upgrade. New v2 Hook semantics do not affect unrelated messaging during subsequent Hook-only updates.

A crash after marker publication but before Profile rename leaves a committed upgrade with Profile selection pending: old mode fails closed, candidate files remain, and read-only reconciliation identifies the exact operation and candidate. Only a new explicit operator continuation may finish deployment after checking the same marker/candidate/Profile scope. It must not issue the upgrade again, rebase, rewrite history or restore v1 grants. A crash after rename uses current selected bytes plus the same history/locator evidence. Unknown link/rename/fsync outcomes are reported as unknown, never rolled back automatically. Binary rollback after the marker requires independently authorized compatibility work; selecting old v1 files cannot restore consent.

This transition adds private format/intent/reader support and operator orchestration only. It requires no Protocol, Store SQL/schema, capability issuance, lease/fencing or frozen execution-event change. If implementation discovers an actual core-contract dependency, it must report the exact required exception instead of extending scope.

## 6. Race and recovery acceptance matrix

| Scenario | Required outcome |
|---|---|
| Target revoke/reauthorize wins before approval's exclusive slot | Approval conflicts; no different-epoch substitution |
| Approval wins; target changes after last check or before fresh load | Recorded old tuple denies that rule, including in a new composition |
| Sender candidate differs from confirmed binding/rule bytes | Generation/hash mismatch refuses; no updated-config reuse of old consent |
| Disabled/removed grant later restored with identical bytes | New generation; old loaded process remains denied |
| Old binding is launched or Profile selection changes | Binding/selection/consent mismatch denies Hooks |
| Grant committed, Profile still old after crash | No new execution; explicit reconcile/continue, no new approval inferred |
| Policy publication or Profile activation has unknown durability | Report separate boundaries, retain files; no retry/rollback/grant replay |
| Own Pi Hook array changes | Old Hook starts denied, ordinary admitted messaging continues before reload |
| Own array toggles true→false→same true | Generation prevents old runner revival |
| Unrelated Pi or unrelated permission changes | Preserve other Session and independent read/ACK behavior |
| Hook update races pending transfer/new factory load | Capture once, reread admission; stale Hook generation denies only Hooks |
| Reload fails/revoked epoch/mapping mismatch | Existing fail-closed behavior, no Owner replacement or old runner resurrection |
| Old writer races upgrade marker / old reader after marker | One slot winner; unknown new kind fails closed; no v1 successor or silent downgrade |
| Queue item was prepared before revoke, child not started | Fresh actual-start admission denies; already-started child may finish |

These are future tests, not claims about the current 104-test baseline. Exercise real publisher/composition/runtime paths, actual process reload/adoption where feasible, and injected failures only at uncontrollable filesystem/process seams. Include old-parser/new-kind refusal, v1-prefix preservation, migration crash windows, same-binding ABA, malformed/oversized/alias paths, absence of any execution during list/config/Connect, and the existing metadata-only/timeout/failure runner suite. Do not duplicate production predicates in a test and then test the copy.

Trust and evidence limits remain the existing operator-owned private filesystem model. Hashes, locators and watermarks are not capabilities, locks or tamper-proof protection against an account owner replacing binaries/history. Unknown or mismatched mode/selection fails closed; never interpret absence as permission or fall back to legacy.

## 7. One implementation and acceptance path after authorization

Continue this same Handoff; do not create a new task per gate or implement a menu first.

1. Characterization/TDD for versioned transition, MCP consent facts and per-registration Hook generations; preserve v1/Core/Store behavior.
2. Implement private v2 parsing/publication/upgrade using existing primitives; wire binding consent checks and separate message/Hook continuity at all identified runtime/transfer sites.
3. Integrate the previously scoped operator-only Hooks manager for list/add/edit/enable/disable/remove and fixed harmless fixture testing. Saving is configuration, explicit reload/start is adoption; it never executes personal scripts or controls transport implicitly.
4. Run targeted race/recovery, runtime/reload and regression checks, relevant typecheck/build, then fixed-diff security review. Report configured, adopted, eligible and executed separately. No commit/install/production migration/transport operation/publication without its own authority.

This round ends with incremental plan/security review of this exact design. A PASS must assess whether the two contracts are sufficient for future implementation and identify any precise unresolved exception; it must not merely approve another description of the blocker. If both pass with no material issue, disposition can be **READY_FOR_IMPLEMENTATION_AUTHORIZATION** for one continuing Hooks management implementation. This round's explicit no-source-implementation restriction remains in force.
