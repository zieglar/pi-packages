# HANDOFF-PI-CE-PUBLIC-PUSH-HOSTED-CI-01

Date: 2026-10-29. Status: completed within authorized scope. Verdict: **ACCEPT WITH FOLLOW-UP**. Public fast-forward push and Linux x64 Native qualification succeeded. Overall Hosted CI failed on a confirmed Public workspace configuration error; npm OIDC Publish remains ineligible until that gate is repaired and verified under separate authorization.

## Git and export verification

Private baseline: `main@ab0ea2161a7f8b9c6a3c966b679da314210b5361`, upstream origin/main, ahead 153 / behind 0 against its cached upstream. Only original untracked AGENTS.md and .herdr-web-ui/ were present; retained throughout. Prior readiness audit and 38-event Ledger were already committed in ab0ea21, so no duplicate closing commit was made before push.

Public export worktree: branch export/ce-native-default-01, no upstream, clean, origin `https://github.com/zieglar/pi-packages.git`. Actual `git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main` succeeded before preflight. Fetched and independently read remote main was `a8386aafd657c84825b2905847f34a43d5b91e1e`. It was the ancestor of exactly these eight ordered direct-parent commits:

| Export | Commit |
|---|---|
| PX-0009 | 0cae6974a718828801663ccdf232bc83cdc1ac5b |
| PX-0010 | 1782d43e3a2c707db7ac583998c0057aef6a4dae |
| PX-0011 | 2a18f59211ddf228e7c6fc8f2182a9843b4f340d |
| PX-0012 | 0e2c479c8cdf5b91baaa5318e0b48a816636037d |
| PX-0013 | b4c57ae5a962e373a34b04d244464fb819796e3b |
| PX-0014 | 2f3a4670b52b6ad6e661ba44f7527f5d1c9268f7 |
| PX-0015 | bb545ae0b686cac4761f47e3e56e1f268ae0cc4f |
| PX-0016 | 0135cc4036a003dd2ec4e108ed1c4fdfb6b953cb |

PX-0016 source mapping was rechecked against reviewed Private e77e0a4: 34/34 blobs identical. Ledger preflight verified 38 events / 16 exports and five negative tests passed. All eight commits were scanned across 91 distinct changed paths: no Private audit/governance/Skills paths, local evidence paths or checked credential markers. The only task-identifier findings were the already accepted public scope label in native-management EN/ZH introductions.

Push command used exact SHA to refs/heads/main, `push.followTags=false`, ordinary fast-forward, no force and no other branch/tag refspec. Push succeeded. Post-push ls-remote and authorized fetch both confirmed main exactly `0135cc4036a003dd2ec4e108ed1c4fdfb6b953cb`; local export HEAD = origin/main with ahead 0 / behind 0. Original Public checkout stayed verify/ce-public-ci-03@86e0efa21645f429aa014b4d5fe2ac68d95434ad, clean and unmodified.

Eight factual PUSHED events were appended to the existing Ledger, preserving identity and source mapping. No CI_VERIFIED event was appended because the overall CI workflow failed. There are now 46 events / 16 exports.

## Exact-SHA Hosted CI

Workflow: **CI**, `.github/workflows/ci.yml`; event **push**, branch **main**, head **0135cc4036a003dd2ec4e108ed1c4fdfb6b953cb**, attempt 1.

Run: **40902068882**, https://github.com/zieglar/pi-packages/actions/runs/40902068882 . Authoritative terminal state: completed / failure. No rerun, manual dispatch or temporary workflow was used.

| Job | Job ID | Runner / Node | Outcome |
|---|---|---|---|
| validate | 123546754899 | Ubuntu 24.04 x64, image ubuntu-24.04 20261025.353.1; Node v24.21.0 | Failure at Validate workspace, exit 1 |
| native (22.19.0) | 123546755471 | Ubuntu 24.04 x64, same image; actual Node v22.19.0 | Success, 15 files / 227 passed / 0 failed / 0 skipped |
| native (24.22.2) | 123546755380 | Ubuntu 24.04 x64, same image; actual Node v24.22.2 | Success, 15 files / 227 passed / 0 failed / 0 skipped |

Each Native job downloaded the existing ce-sqlite-v0.1.0 Release assets, verified four checksums and seven attested subjects against exact source a8386aafd657c84825b2905847f34a43d5b91e1e, then prepared/selected using the shipped production NATIVE_COMPAT without an external manifest override. Logs confirm production pins match the Release manifest and report driver rust-native, ready true, middlewareVersion 0.1.0, ABI 1, SQLite 3.54.1, buildId a8386aa and target x86_64-unknown-linux-gnu. The Linux x64 production asset pin is d93db0cf84621495154ff98f3b293b615593967060050b38d9ceaee6871efaf7.

All 15 test files print the Rust qualification marker. native-default tests additionally exercise absent selection/default resolution and deny builtin SQLite access; no automatic node:sqlite fallback was observed. This is default-path evidence, not a claim that every diagnostic test prohibits an intentional Node control import.

Per job test inventory: message-send-read 21; message-creation-concurrency 10; store 12; native-artifact 13; runtime 100; native-readiness 9; native-default 9; runtime-api 16; native-readiness-gate 6; native-value-regression 9; transaction 7; native-cli 5; native-command 1; native-production-pin 2; lease-lock-wait 7. Total 227.

This covers trusted installation and identity, default driver resolution, Store initialization and reopening, transactions and persistent values, WAL/concurrent lock waits, missing/corrupt cache readiness, and Tunnel start refusal before manager effects. Tunnel gate cases use the existing mocked management boundary and do not connect a real Tunnel. Linux arm64 is not in the existing matrix and remains unverified. Full recovery/SIGKILL qualification was local in the preceding handoff; this Hosted inventory is bounded and is not a complete Linux storage suite.

## First failure and attribution

The validate job reached `pnpm check:workspace`, then emitted `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` / `Command "check:workspace" not found`, exit 1. Public root package.json has build/typecheck/test/check/format:check scripts, but no check:workspace. No root scripts directory supplies an executable by that name.

Classification: **CI configuration / Public workspace mismatch**. It is reproducible from the exact workflow and root manifest; it is not a Native correctness/trust/loader/WAL failure, Node22 compatibility failure or external service failure. The job's Build, Typecheck, Check packages, Test and Check diff hygiene steps were skipped after the failure. It therefore supplies no ordinary-suite test result. The previous Node22 2930-test local results and 22 attributed failures are historical evidence only; none of those failures occurred in these 227-test Native jobs.

Smallest suggested follow-up: authorize a Public-compatible workspace validation implementation/entry point, or a precise workflow adjustment to invoke the equivalent real Public checks. Preserve validation intent; do not add an empty script, skip the gate or relax tests. No such modification was made. A deterministic missing command gives no value from rerunning the same unchanged workflow.

## npm and release boundaries

Read-only npm metadata confirms @zieglar/pi-chat-exchange@0.2.0 still exists. The npm Trusted Publish workflow exists, is workflow_dispatch-only, requires publish=true and exact-SHA preflight, main/repository restrictions, environment npm-release and id-token:write for OIDC. It was not dispatched. Environment API still reports main-only branch policy 64744273, no reviewer rule and can_admins_bypass=false. The npm-side Trusted Publisher connection was not independently revalidated in this run; no configuration was changed and no npm token was used.

Read-only Release metadata confirms immutable ce-sqlite-v0.1.0 Release 427441708, eight assets, unchanged publication identity. No Native asset, tag, Release, production pin, compatibility range or binary changed.

**npm OIDC Publish readiness: NO.** Overall required CI is red; the workspace gate must be fixed and exact authorized source pass the required checks first. Published npm 0.2.0 also cannot be overwritten: a future publication requires an independently authorized concrete version and commit, plus registry absence preflight. No version bump was made here.

## Review, evidence and delivery state

Prior production review remains four independent contexts through e77e0a4, followed by local Readiness and Node22 qualification acceptance with follow-up. This task reverified source/export/privacy/Git facts and inspected authoritative CI logs; it did not claim a new code review or cross-family independence.

Raw and structured evidence is retained outside repositories at `/Users/zieglar/Code/Pi-Project-Evidence/chat-exchange/public-push-hosted-ci-01/`: preflight-git.json, authorized-chain.json, privacy-scan.json, ledger.json, ledger-negative.json, post-push.json, run-final.json, jobs-final.json, validate-first.log, native-22.19.0-first.log, native-24.22.2-first.log, linux-native-test-proof.json, job-evidence-summary.json and npm/Release metadata. First log-fetch attempts are preserved: gh refused terminal escape bytes until explicitly requested for capture; no initial failure evidence was discarded. Secrets were not inspected; GitHub log credentials remain masked.

Implemented: existing accepted production code unchanged. Tested: actual Linux x64 Hosted Native matrix passed at the pushed SHA. Dogfooded: no new production or interactive deployment; preceding isolated Pi first-run evidence remains historical. Released: Public source main now includes PX-0009..PX-0016; existing Native Release unchanged; no new npm release or production deployment.

Risks/follow-up: ordinary CI gate failure blocks npm publication, Linux arm64/WSL2/cloud unverified, Hosted Native lane is not exhaustive power-loss/recovery proof. ACCEPT WITH FOLLOW-UP reflects successful push and core Native CI with a fully attributed configuration failure, not overall CI success. No rebase/reset/merge/cherry-pick/force push, PR, workflow edit, test modification, npm publish, Trusted Publisher change or Tunnel connection occurred. Stop pending a separately authorized CI fix or publication decision.
