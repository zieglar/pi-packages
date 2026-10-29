# HANDOFF-PI-CE-NATIVE-READINESS-01 — local acceptance

Date: 2026-10-29. Verdict: ACCEPT_WITH_FOLLOWUP for the authorized local implementation and bounded export. No production deployment or new publication occurred.

## Fixed identities and scope

Private baseline `6d639385de058fa76e0eb5635868fc25f9e57b9f`; implementation `6419e06175c49e512c00eba3252d3cb89ca04689`; reviewed remediation `e77e0a4ecada911a2f60ca10a7b8dc18e55472bc`. This report and Ledger additions are Private evidence, outside the reviewed production delta and excluded from Public export.

Public PX-0016 is `0135cc4036a003dd2ec4e108ed1c4fdfb6b953cb`, directly on PX-0015 `bb545ae0b686cac4761f47e3e56e1f268ae0cc4f`. All 34 exported blobs equal their recorded Private source blobs. Public ancestry was preserved by copying the bounded file inventory; no Private commits were merged. The original Public checkout and unrelated worktrees were retained. Original untracked `AGENTS.md` and `.herdr-web-ui/` were retained.

The only authorized trust addition is published `ce-sqlite-v0.1.0`: immutable Release `427441708`, source `a8386aafd657c84825b2905847f34a43d5b91e1e`, ABI 1, bundled SQLite 3.54.1. Four asset SHA-256 values were recomputed from the actual Release downloads, checked against SHA256SUMS and the manifest, with strict repository/workflow/ref/source-bound verification of seven attested subjects. No Release asset was rebuilt or changed.

| Target | Production SHA-256 |
|---|---|
| aarch64-apple-darwin | b3b0102931f4fd50459e435cd0ac3ad68f61f9c00c0c14366eb03ab5f4b71db3 |
| x86_64-apple-darwin | 53f036cca6b43a75f340c192dc67b070919904ad3590f5e63fa56a6d408e180b |
| x86_64-unknown-linux-gnu | d93db0cf84621495154ff98f3b293b615593967060050b38d9ceaee6871efaf7 |
| aarch64-unknown-linux-gnu | 6186c334e362d283481182efd1c6e8eaa98702b76bd6c3e5e933d584263c99d2 |

## Implemented behavior

- Native remains the sole default. Explicit node-sqlite compatibility selection remains available and is never an automatic fallback. Pi Host engines remain `>=22.19.0`.
- Local readiness returns READY, MISSING, UNTRUSTED, INCOMPATIBLE, INITIALIZATION_FAILED or UNSUPPORTED_PLATFORM. Inspection reuses the selected version, fixed trust manifest and verified cache loader; it opens no Store, downloads nothing, changes no selection and starts no Tunnel. A verified module can be loaded for identity inspection.
- `/ce-native` registers independently of messaging. Missing Native preserves plugin loading and management commands. The fixed startup warning appears at most once per extension instance. Explicit node-sqlite selection does not receive the inaccurate messaging-disabled Native warning.
- `/ce-native status` and `verify` inspect locally. `install` prepares only the shipped trusted default before selection; `repair confirm` additionally replaces a hash-corrupt regular private cache entry only after a pinned download passes verification. Unsafe permissions, ownership and paths remain refusals. Failed download/hash verification preserves old bytes and selection; valid cache is reused. Pi restart is required; messaging is not automatically resumed.
- `check-updates` fetches Release metadata for discovery only. It neither trusts a new version nor installs/selects it. Unknown versions, unpinned bytes and incompatible identities remain closed.
- Every actual Tunnel start first rechecks Native and existing Store runtime eligibility before manager/profile/process effects. Store runtime refusals retain `STORAGE_RUNTIME_INELIGIBLE` and the existing sanitized runtime hint. Status reports Native separately from transport lifecycle; unavailable Native does not imply STOPPED. Owned stop remains usable and retains existing identity/ownership checks.
- Windows native is refused. WSL2 guidance requires Linux Node/Pi/CE and recommends a Linux filesystem for active Store data. Four artifact targets do not expand the Store allowlist, which remains darwin/arm64 and linux/x64. No WSL2 integration qualification is claimed.
- English and Simplified Chinese guides cover commands, trust, no automatic updates, restart, platform and publication limits. README links target GitHub because detailed docs are excluded from npm.
- Fixed a pre-existing validate-only regression in the prior handoff: return had been inside the module traversal loop. It now validates every module without creating an artifact. The existing missing-transitive-module test exposed this defect.

No protocol, Delivery/ACK, Ownership/Recovery, Store schema or domain SQL semantics changed. DELIVERY_UNKNOWN is not CANCELLED. Missing ACK does not authorize blind retry; Native recovery and model changes do not authorize replay. No exactly-once claim, dynamic trust service, new state database or new task-completion authority was added.

## Verification and limits

Evidence directory: `/Users/zieglar/Code/Pi-Project-Evidence/chat-exchange/native-readiness-01/`. First failures are retained alongside successful reruns.

| Check | Observed result | Evidence |
|---|---|---|
| Production-pin test before/after pins | RED then 2/2 GREEN | production-pin-red.log, production-pin-green.log |
| Published identity and trust verification | Four checksums, seven source-bound subjects; tag/Release identity reconfirmed | downloaded-asset-sha256.json, strict-attestation-verify.json, release.json, tag.json |
| Production prepare/status without selection or external manifest | READY using shipped pins; prepare created no selection | production-no-selection-prepare.json, production-no-selection-status.json |
| Production Native initial targeted | 148/148 each on Node 22.19.0 and 24.22.2 | production-native-targeted-22.19.0.log, production-native-targeted-24.22.2.log |
| Default explicit Node compatibility lane | 2861 passed, 17 skipped, no failures | default-lane-full-2.log; before repair addition and final diagnostic remediation, so not a full final-SHA rerun or Native qualification |
| Real module targeted (before diagnostic remediation) | 60/60 | final-targeted.log |
| Explicit corrupt-cache repair regression | RED then passes with local bytes from published module | repair-red.log, final-targeted.log |
| Final CI test inventory, macOS arm64, production Native | 227/227 on Node 22.19.0; 227/227 on 24.22.2 | final-ci-list-22.19.0.log, final-ci-list-24.22.2.log |
| Rust conformance on Node 22.19.0 | 9 passed; 9 Node-control tests excluded by name | final-production-native-22.19.0-rust-conformance.log |
| Final Store diagnostic command test | 6/6; mocked gate throws real RuntimeEligibilityError type | gate-r2.log; no real foreign-platform end-to-end test |
| npm release gates | 32/32 | final-npm-release-2.log |
| Contract, Native contract, typecheck, build | Exit 0 | final-contract.log, final-native-contract.log, final-check-exit-status.json |
| Final minimal tarball | 88 entries; no .node, detailed docs, Chinese docs or Private files | package-final.json, final-pack-r2.log |
| Actual installed Pi 1.3.0, Node 22.19.0, final tarball | Install, load, first-run, profile/policy/mutex/Store persistence PASS; cloud NOT_VERIFIED | final-installed-host-22.19.0-r2.log, installed-host-final-location.json |
| EN/ZH docs | 56 pairs, no missing switch links or broken local links | docs-validation.json; two inherited plan references to literal /Users/ and two inherited differing code fences remain outside changed-doc concerns |
| Public export | Direct parent PX-0015, 34/34 source/target blobs; export worktree clean | px16-paths.json, px16-committed.json |
| Ledger | 38 append-only events/16 exports; Git provenance pass; negative checks 5/5 | final-ledger.log, final-ledger-negative.log |

Final tarball SHA-256: `d7bfbaf025d02aaaff4f10b607fc7beb7f8059d03daf8787848efee2aeafb60c`. The actual Host run used those exact bytes from `package-final/zieglar-pi-chat-exchange-0.2.0.tgz`. The Host fixture copied the verified production cache into a private HOME without a selection file, using shipped pins. Real Host evidence is retained at `/private/tmp/ce-distribution-fix/installed-host-ehxr9cm9`. Install fixture, credentials and policy were isolated; no operator production installation was modified.

Changed Public files were scanned for local evidence paths, credential markers and the Private task identifier. The only identifier matches were the public guide's scope label in the two native-management introductions; these contain no Private instructions, plans or evidence. There were no local evidence path or credential-marker findings. Four review contexts checked privacy and documentation as part of their scoped reviews.

## Previous Node 22.19.0 failure attribution

The previous Native-labeled full run had 1001 passed, 29 failed and four skipped; its failure log remains in native-default-01/final-rust-suite-22.19.0-run2.log. Read-only failure attribution mapped 14 transaction-return cases to Node-specific expectations, three to unavailable Node APIs, nine to raw Node-reader parameter differences, one to stderr-warning assertions, one transaction-security case to the Node path, and one cross-driver ambiguous-outcome case whose first failure remains insufficiently attributed. These are not 29 proven Native correctness regressions, and the ambiguous case is not declared resolved by this report.

An additional mixed conformance run in this task recorded 74 passed, three failed and four skipped; all three failures were explicitly named node control cases (extended errors, authorizer and defensive mode). The separately selected Rust conformance cases passed 9/9, and the production CI inventory passed 227/227 on minimum Node. This narrows the acceptance evidence; it does not turn either historical full suite into a pass, qualify all Node builds, or eliminate the inherited ambiguous-outcome coverage limitation.

## Independent-context reviews

All four reviewers inspected the fixed delta through `6419e06175c49e512c00eba3252d3cb89ca04689`. Lane 1 covered diff/privacy/docs, lane 2 fixed authority/contracts, lane 3 validation/coverage and lane 4 standards/maintainability. Lanes 1/2 passed; lanes 3/4 independently found the same P2 Store runtime error misclassification. The parent verified and fixed it in `e77e0a4ecada911a2f60ca10a7b8dc18e55472bc`, added a bounded regression, and all four lanes returned incremental PASS for the combined final range.

Reviewers used separate contexts with magpie/group/smart-split and compatible low thinking. The underlying model family is unknown; this is not a cross-family or two-person independence claim. Reviewers did not rerun suites or remotely reverify attestation, and correctly noted empty typecheck logs alone do not prove success. The parent subsequently recorded actual exit codes in final-check-exit-status.json.

## Delivery status

Designed and implemented: complete for this bounded handoff. Tested: the exact local checks above. Dogfooded: isolated installed Pi 1.3.0 first-run on Node 22.19.0 using final tarball and production pins. Released: the existing Native v0.1.0 Release only; this CE source delta is not published. Local Public export: complete, PX-0016 only COMMITTED.

Remaining follow-up: hosted Linux CI, real WSL2 integration, cloud transport, exhaustive full Native qualification and inherited ambiguous cross-driver outcome coverage are not verified by this task. macOS x64/Linux arm64 artifact availability is not Store runtime qualification. Existing npm 0.2.0 remains historical and cannot be overwritten. No push, PR, merge, workflow dispatch, tag/Release modification, npm publication or production deployment was performed.
