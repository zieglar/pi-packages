# HANDOFF-PI-CE-PUBLIC-CI-VALIDATE-FIX-01

Date: 2026-10-30 local / 2026-10-29 UTC. Verdict: **ACCEPT**. The missing Public workspace validation entry is repaired, the real checker and negative regressions execute, PX-0017 was normally pushed, and exact-SHA Hosted CI completed success on the first attempt. No npm publication or production deployment occurred.

## Baseline and root cause

Private baseline: main@fa7a0ea65226a4ff6e7a1ef906869abf722af1d0, cached upstream origin/main ahead 154 / behind 0. Public export: export/ce-native-default-01@0135cc4036a003dd2ec4e108ed1c4fdfb6b953cb, no upstream, clean. Actual authorized Public fetch confirmed origin/main at that exact PX-0016 SHA. Origin is https://github.com/zieglar/pi-packages.git. Original Public checkout remained verify/ce-public-ci-03@86e0efa21645f429aa014b4d5fe2ac68d95434ad, clean. Original untracked AGENTS.md and .herdr-web-ui/ were preserved. Full repo/branch/worktree/remote/upstream/ahead-behind observations are in baseline.json.

Private root package.json defines check:workspace as `node tooling/check-workspace.mjs`. The checker enforces the frozen package-directory inventory, required scripts, nested-lockfile/symlink prohibition, package-relative imports, declared internal dependencies/public entry usage, entry paths and acyclic runtime dependencies. It iterates packages actually present; it does not require Private packages to exist.

Public root package.json intentionally has a smaller orchestration surface, without Private Changesets configuration or check:workspace. Its package-level check verifies CE contract/Native declarations, not workspace boundaries. The shared CI workflow had retained `pnpm check:workspace`, while the entry and checker were not exported. This was an export/CI integration omission, not a Native or Node22 defect. Run 40902068882 retained the first Hosted missing-command failure.

## Minimal change and fixed review

Private implementation commit: **3fdacd131da13bed231d61ea5f86bab885ec0c83**.

- `.github/workflows/ci.yml`: replace the missing root-script invocation with a fail-fast block running `node --test tooling/check-workspace.check.mjs` followed by `node tooling/check-workspace.mjs`.
- `tooling/check-workspace.check.mjs`: nine bounded real filesystem/CLI regressions. CI entry assertion was RED before the workflow change; after the change, all tests pass.
- `tooling/check-workspace.mjs`: exported unchanged from existing Private source commit **5a84cb1721d87a6f324d4d288ce0beac3dda1579**. No change to its validation policy or ignore sets.

The normal Public fixture contains only one package and Node builtins, with no root Private manifest, dependencies or Changesets. Negative states reject unknown package inventory, missing required script, nested lockfile, relative import escaping a package, missing entry, symlink, undeclared/private cross-package import and circular runtime dependencies. No empty script, unconditional success, continue-on-error or weakened gate was added.

One targeted independent-context reviewer inspected fixed 3fdacd13 and all three proposed export files, returning PASS. It checked preserved semantics, Private dependency/privacy, fail-fast CI, exact scope and npm inventory. Model route magpie/group/smart-split, compatible low thinking; underlying family unknown, no cross-family claim. The original text-based import scanner remains an existing limitation, not a full parser/static-analysis guarantee.

## Local validation, including first failures

Public staging was produced from a git archive of exact PX-0016, with only the three proposed export files overlaid; the Public checkout itself was not used as an unrecorded development source. The isolated tree contained no Private root manifest/lock changes.

| Check | Result |
|---|---|
| Existing Private checker | Exit 0, two packages |
| Regression before workflow fix | Exit 1: CI entry assertion fails; eight semantic cases pass |
| Regression after workflow fix | 9/9, exit 0 |
| Same regression in isolated full Public staging | 9/9, exit 0 |
| Actual full Public workspace checker | Exit 0: one package; inventory/scripts/locks/imports/entries/dependency graph valid |
| Public frozen-lockfile install --ignore-scripts | Exit 0 |
| Public build, typecheck, check | Each exit 0 |
| Canonical Public pnpm test, first run | Exit 1: 2860 passed, two failed, 18 skipped, 2880 total |
| Bounded original two-file rerun, one worker | 38/38, exit 0, no timeout/test edits |
| CE distribution boundaries | 21/21, exit 0 |

The two first-run failures were existing default 5000ms test timeouts: `test/tunnel/extension-manager.test.ts` / `Manager Setup saves a real isolated profile, returns fresh STOPPED, and Start still refuses the gate`; and `test/package/durable-state.test.ts` / `refuses paired mutex records both missing processToken`. First raw stdout/stderr are preserved. Both files and the entire CE package tree were unchanged from the baseline; lowering parallelism for one diagnostic rerun passed 38/38 without changing deadlines. This is consistent with local scheduling/resource contention but does not erase the first failures or prove they can never recur. Hosted original test commands subsequently passed without a retry. No unrelated test timeout fix was made.

## PX-0017 export and push

PX-0017: **7e8795e8ff421fd557fcd28ae5db784e8b7bff95**, direct parent **0135cc4036a003dd2ec4e108ed1c4fdfb6b953cb** (PX-0016). Three exported blobs equal their fixed Private source blobs, with per-path source commits recorded. Existing PX-0009..PX-0016 history was retained. All CE/Native package files remain byte-identical to the respective previous Private/Public package trees; existing Private/Public differences remain preserved rather than flattened.

Public paths are exactly the workflow and two tooling files listed above. No Private plan/audit/governance/Skills, credentials or machine paths were exported. Private root package.json, dependencies and Changesets were excluded. CE package.json/files whitelist/runtime tree were unchanged, so npm payload does not expand. The root workspace package remains private.

Before push, Ledger validation passed 48 events/17 exports and all five negative tests. Re-fetch confirmed remote main still PX-0016 and the exact direct parent. Push used normal fast-forward, exact PX-0017 SHA to refs/heads/main, push.followTags=false, no force/extra branches/tags. Remote ls-remote and fetch after push confirmed main precisely PX-0017 and export HEAD versus origin/main 0/0.

Ledger adds only PX-0017 PENDING_EXPORT, COMMITTED, PUSHED and CI_VERIFIED, preserving all earlier 46 events. Final count is 50 events / 17 exports. CI_VERIFIED belongs to exact PX-0017; no earlier failing run was relabeled successful.

## Exact-SHA Hosted CI

Workflow **CI**, `.github/workflows/ci.yml`; run **40907970721**, https://github.com/zieglar/pi-packages/actions/runs/40907970721 . Event push, branch main, head **7e8795e8ff421fd557fcd28ae5db784e8b7bff95**, attempt 1; authoritative terminal state completed/success. Created 2026-10-29T16:04:42Z, completed by 16:08:37Z. No rerun, manual dispatch or alternate workflow.

| Job | Job ID | Actual runner and Node | Result |
|---|---|---|---|
| validate | 123567846853 | Ubuntu 24.04 x64, image ubuntu-24.04 20261025.353.1; Node v24.21.0 | SUCCESS |
| native (22.19.0) | 123567847324 | Ubuntu 24.04 x64, same image; Node v22.19.0 | SUCCESS, 15 files / 227 passed / zero failed or skipped |
| native (24.22.2) | 123567847180 | Ubuntu 24.04 x64, same image; Node v24.22.2 | SUCCESS, 15 files / 227 passed / zero failed or skipped |

Validate executed regression 9/9 and printed `WORKSPACE OK: 1 package; inventory, scripts, locks, imports, entries, and dependency graph valid`. Build, Typecheck, Check packages, Test and Check diff hygiene all executed and succeeded. Default test lane: **2856 passed, 24 skipped, zero failed, 2880 total; 174 passed files and two zero-registration skipped files**. This lane explicitly selects node-sqlite compatibility; it is not Native full-suite qualification.

The existing 24 skips remain platform/fixture/opt-in conditions: local-plugin-package four; multi-session-policy-validation one; executable Darwin ACL cases four; native-readiness local binary fixture two; native-default fixture seven; desktop-manifest one; filesystem one; unsupported-runtime admission four. runtime-cross-version and runtime-wal-safety have zero registered tests without their explicit binary environment. No skip/exclude/timeout/matrix configuration was modified. Hosted Native jobs supply real assets for the relevant Native cases and have no skips.

Both Native logs confirm four checksums/seven source-bound attested subjects, production pins matching the published manifest, 15 `CE Native qualification: rust-native 0.1.0 SQLite 3.54.1` markers, target x86_64-unknown-linux-gnu and actual selected/default Native behavior. Native workflow block, Release ce-sqlite-v0.1.0, ABI1/source a8386aa, binaries and production pins are unchanged. Linux arm64, WSL2/cloud, physical power-loss and exhaustive Linux recovery remain outside this bounded check. No new Native correctness or safety failure was observed.

## Evidence and next-stage boundary

External evidence: `/Users/zieglar/Code/Pi-Project-Evidence/chat-exchange/public-ci-validate-fix-01/`, including baseline.json, regression-red/green, staged checks, local-checks.json, first test logs, two-timeout-bounded-rerun.json, distribution.json, fixed review summary, per-path source records, push-preflight/post-push, authoritative run/jobs JSON, all first job logs, native-hosted-proof.json, Ledger validation and negative cases. The temporary watcher timeout was not treated as CI failure; terminal GitHub state was queried independently.

Implemented: minimal CI entry and regression repair. Tested: isolated Public local checks and exact-SHA Hosted full workflow SUCCESS. Dogfooded: no new interactive or production usage; existing isolated Pi acceptance remains prior evidence. Released: Public source PX-0017 pushed; no npm publication, version bump, tag/Release change or deployment.

There is no unresolved blocker within this handoff. Recommend entering a separately authorized **npm OIDC publication acceptance** phase: exact publish version/SHA, registry absence and artifact preflight still required; existing npm0.2.0 cannot be overwritten. No Trusted Publisher/Environment/release permission was changed. Stop after audit/Ledger closure pending independent npm Publish authorization.
