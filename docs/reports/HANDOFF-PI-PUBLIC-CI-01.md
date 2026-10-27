# HANDOFF-PI-PUBLIC-CI-01 — First Public CI Failure

## Verdict

**BLOCKED — READY_FOR_PUBLIC_SYNC: NO.** Minimal fixes and targeted Linux validation are complete; the exact candidate's default full suite is not green. Do not export/push on the strength of this report. Native Linux x64 validation and resolution of remaining default-suite failures are required. No public repository, real Tunnel/Store, remote ref, release or publication was modified.

## Baseline and evidence

- Private development: `main`, HEAD `9e673bf52c212c4a8c89c1e41f36db82fbbcfbf1`; upstream `origin/main`, ahead 110 / behind 0 (local tracking ref, not fetched). Tracked tree clean before work. Existing untracked `AGENTS.md` and `.herdr-web-ui/` left untouched. No exact private starting SHA was supplied by the handoff.
- Public distribution: run https://github.com/zieglar/pi-packages/actions/runs/40499683066, attempt 1, job `122173940032` (`validate`), SHA `6a3338dde60a5d36f07594159b8efe97f45f8f57`, conclusion failure.
- Original result: **27 failed / 2711 passed / 26 skipped**, 7 failed files, 160 passed files, 1 skipped file. Build/typecheck/check preceding Test succeeded.
- Raw logs and metadata are retained locally under `.git/handoff-evidence/HANDOFF-PI-PUBLIC-CI-01/` (also staged during execution at `/tmp/HANDOFF-PI-PUBLIC-CI-01/`). This directory is private evidence, not tracked/exported.
- Original `logs.zip` SHA256: `55c4a70cc92430d6bce9a4877788a75d2485242b7b6ceeefc4346a604f97036c`; `jobs.json`: `974fc2567f0c38fb43aff6e2860aef8fd5532710df455467ba6e674b71883d80`; `run.json`: `1a789a9193c397c1c0217b929287531177cf0a3d16728d7a53371bc24bb1973c`.
- Downloaded the exact public SHA archive read-only. 350 public files match private baseline byte-for-byte; only root `package.json`, lockfile, README, `.gitignore`, and workflow differ. Every one of the seven fix preimages matches. No private root configuration/lockfile is to be copied to public.

## Root Cause Matrix

| Area / original failures | Classification and evidence | Minimal correction / verification |
| --- | --- | --- |
| PTY/Guardian: 23 (failure-path 5, harness-cleanup 15, package guardian 3) | Test-supervision implementation defect with cascades. `members()` applies positive PGID validation to every row of a system-wide `ps` snapshot. Linux kernel threads legitimately have positive PID, PPID 0, PGID 0; those unrelated rows trigger `invalid process identity`. Cleanup then reports unconfirmed; fallback aggregation/early exits mask the intended injected errors. The historical log shows this refusal but does not retain the offending raw row, so the exact historical PID is unknown. | New Linux fixture `2 0 0 S` + target zombie fails before correction. Permit zero PGID only as a strictly parsed unrelated row; require target PGID to be a positive integer. Keep PID-zero, malformed/negative rows, stderr/nonzero/empty refusal, conservative unknown states, final-kill-before-reap, and offline confirmation gates. Targeted real guardian/descendant tests pass. |
| Node executable: 1 | Non-hermetic positive test assumes `process.execPath` is trusted. CI's toolcache candidate is refused; original logs do not reveal which ancestor metadata failed. Reproduced original assertion with a group/world-writable synthetic toolcache and no approved default fallback. Not evidence of a resolver defect. | Positive selection uses a private copied runtime; deterministic unsafe-current-path test retains refusal. Production resolver, ownership/mode/ACL checks and runtime identity probe unchanged. |
| Tunnel STOPPED state: 1 | Fixture environment assumption / cascade of missing trusted Node. Setup cannot publish a profile, so Manager stays UNCONFIGURED; not a STOPPED transition bug. Reproduced on unmodified public archive with unsafe toolcache and no approved fallback. | Supply private canonical `node` through `CE_NODE_PATH`, require profile publication before STOPPED, retain unauthorized Start refusal and unopened Store assertions. |
| Tunnel Profile / missing client: 1 | Fixture fails Node qualification before reaching missing-client refusal (`resolveSetupNodePath`, `mcp.commands.0.command`). Reproduced on unmodified public archive. No evidence of production profile-validation defect. | Supply trusted private executable named `node`, preserving the unchanged profile grammar. Assert saved profile unchanged/inspectable, zero client spawns and unopened Store after missing-client refusal. |
| RPC initialize timeout: 1 | Independent debug-launcher implementation defect. POSIX asynchronous lists may substitute `/dev/null` on stdin before `<&0`; `/bin/sh` is dash in tested Linux. Pure shell regression produces empty stdout before fix; real launcher test times out on unmodified public snapshot. Not Node discovery cascade. | Save caller stdin on fd 3 before backgrounding, restore child stdin and close fd 3 in child and parent. Pure shell regression and actual JSON-RPC/log/signal-shutdown integration pass. No timeout increase. |
| Additional Linux-only fault-injection gap | Existing test assumes `/dev/ttys*`. On Linux `/dev/pts/*`, replacement-open fault never fires; exposed after cleanup passes. Unmodified public snapshot reproduces missing failure. | Recognize both PTY slave prefixes in the test spy only. Keep assertions that the fault fires, no predecessor PGID reuse, and no fabricated barrier. |

## Changed files / controlled export delta

All paths below are relative to `packages/pi-chat-exchange/`:

1. `scripts/debug-plugin/launch`
2. `test/host-regression/harness-cleanup.test.ts`
3. `test/host-regression/support/pty-driver.py`
4. `test/plugin/debug-stdio.test.ts`
5. `test/runtime/executables.test.ts`
6. `test/tunnel/extension-manager.test.ts`
7. `test/tunnel/portability.test.ts`

Code/test delta: **75 insertions, 9 deletions**. Export patch: `.git/handoff-evidence/HANDOFF-PI-PUBLIC-CI-01/fix.patch`, SHA256 `af3669be5c89d6325508c09440b9081683fbe1f93f2eb839e887f008db82b161`. It passes `git apply --check` against the exact public archive; candidate seven-file hashes equal private working files (`candidate-sha256.txt`, `private-sha256.txt`). This report is an eighth, private-only changed file and is **not** part of the public delta. No version, lockfile, workflow or release-contract change.

## Tests executed / results

Evidence filenames below are relative to the private evidence directory.

| Execution | Result / evidence |
| --- | --- |
| Initial private-baseline Linux container reproduction | 85 passed / 6 failed / 4 skipped (`linux-baseline.json/log`). This first attempt used root, umask 0000 and overlayfs: extra executable-ancestor and Store filesystem refusals are environment failures, not fixes to weaken. Replaced environment rather than relaxing checks. |
| Newly added PGID-zero and POSIX stdin regressions before implementation | Both fail for expected reasons (`linux-red.json/log`). Name-filtered nonexecuted tests are recorded separately as pending. |
| Corrected private Linux targeted run, seven original failed files | 94 passed / 0 failed / 4 skipped (`linux-targeted-green.json/log`). |
| Unmodified public archive with unsafe toolcache | Reproduces RPC timeout, current-runtime trust assertion and Linux tty fault-injection gap (`public-before.json/log`). With approved system fallback removed, reproduces all three Node/Tunnel failures (`public-before-node.json/log`). |
| Exact public archive + seven-file patch, frozen public lockfile | `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm check`: pass (`candidate-install-build.log`, `public-candidate-validation.log`). |
| Exact public candidate, unchanged default `pnpm test` | **2735 passed / 6 failed / 26 skipped; 3 unhandled errors** (`public-candidate-validation.log`). Not green. Details below. |
| Exact public candidate, final seven-file targeted run without approved system Node fallback | **94 passed / 0 failed / 4 skipped** (`public-targeted-final.json/log`). Same code hashes as private fix. |
| Three remaining failing files, `--maxWorkers=1` | 59 passed / 2 failed / 0 skipped / no reported unhandled errors (`linux-remaining-serial.json/log`). Lease-lock-wait tests pass serially; distribution environment and reconcile default timeout persist. |
| Reconcile-only diagnostic, `--maxWorkers=1 --testTimeout=20000` | 24 passed (`reconcile-diagnostic.json/log`). This is diagnostic only, **not** the default CI command; no committed timeout or assertion changes. |
| Active LSP diagnostics, five changed TS files | 0 errors, all five checked clean. |
| Diff/syntax checks | `git diff --check` passes. Reviewers also checked shell syntax and isolated descriptor/parser/barrier probes. |

One exploratory candidate command incorrectly invoked private-only `pnpm check:workspace` on the public root; it failed before validation. Retained as `candidate-wrong-root-command.log`, then corrected to the actual public workflow commands. No result was silently overwritten.

### Remaining full-suite failures / BLOCKED conditions

- `test/package/distribution.test.ts`: private-environment assertion sees extra `UV_USE_IO_URING=0` in actual Node subprocesses. A clean `env -i PATH=/usr/bin:/bin <node> -p JSON.stringify(process.env)` reproduces it; clean Python control does not. Runtime/environment behavior is demonstrated; attribution specifically to emulation is not proven. Do not allowlist the variable or weaken environment-leak assertions on this evidence alone.
- Same file: native-inventory author-command 5-second timeout under full concurrency; passes in serial rerun.
- `test/tunnel/reconcile-session-mutex.test.ts`: wrong-expectation loop exceeds default 5 seconds even in serial run; passes with diagnostic 20-second budget. No source or timeout changed.
- `test/storage/lease-lock-wait.test.ts`: three before-expiry initiation assertions fail under full concurrency; cleanup yields three unhandled child-result errors. All tests pass in serial rerun. Scheduling sensitivity is supported, but native default-concurrency validation remains required.
- The original public run passed these three files. They are additional local validation failures, not misrepresented as original public CI failures or silently skipped.
- Pre-existing Vitest warning: nested `vi.mock` in `test/support/default-client-guard.ts` is hoisted; future Vitest compatibility issue, unchanged.

### Skips and exclusions

Final targeted 4 skips are the pre-existing macOS ACL tests, not Linux cleanup tests. Full candidate's 26 skips: local-plugin-package 4, multi-session-policy-validation 1, executable ACL 4, runtime-cross-version 12, desktop-manifest 1, runtime-admission 4. Existing default-script exclusions remain real-client compatibility, offline integration, real-host recovery, and installed-host distribution lanes. None was enabled against a real installation, Tunnel or Store. No new skips were added.

## Linux validation environment

- OrbStack Linux container on a Darwin arm64 host; **emulated Linux x86_64, not native x64 and not GitHub-hosted Ubuntu**.
- Image `node:24.21.0-bookworm`, ID `sha256:b795e77f6c253b171f482eff27b9b882dc4cdcb42d773372e298481c7318fbc2`; Node v24.21.0, pnpm 12.9.1, Python 3.11.2, `/bin/sh -> dash`.
- Corrected runs: uid 1000, explicit umask 022, Btrfs-backed Docker volume mounted at `/tmp` (type `0x9123683e`), no host home/config/Store mounts. `--init` for orphan reaping. Network detached after dependency installation and before candidate validation.
- Synthetic `/opt/hostedtoolcache` mode 0777 with copied Node intentionally exercises unsafe discovery; approved default Node fallback removed for final public candidate tests. Production trust/Store filesystem gates left unchanged.
- Container names `pi-public-ci-01` and `pi-public-ci-01-ext4`, volume `pi-public-ci-01-tmp`. These are task-created isolated fixtures only, not production resources.
- Reproduction commands and exact environment are retained in evidence. macOS tests are not substituted for Linux results.

## Security / authority review

- Seven-file fixed-patch review: no actionable correctness findings; security review: no confirmed exploitable defects. Both explicitly decline full-suite readiness.
- Target group remains positively validated; malformed/unknown evidence stays fail-closed; no live/unknown state becomes dead; final signal remains before anchor reap. PGID-zero rows cannot authorize signalling or offline status. No stored/reaped PID gains authority.
- Production executable admission, runtime eligibility, Tunnel Profile grammar, gate checks and filesystem whitelist unchanged. fd 3 is closed in both launcher and workload.
- Requested reviewers were `anthropic/claude-opus-5-5` (reviewer medium; security-reviewer high); runtime reported `openai-codex/gpt-6.1-sol`. Therefore these are **fresh context-isolated same-family reviews, not cross-family independent verification**. Scouts had the same model-report mismatch. Linux evidence was produced by parent, not independently rerun by reviewers.
- Source authority remains Private Development -> Public Distribution. Public access was read-only metadata/log/archive retrieval; candidate is a temporary extracted snapshot, not a public Git checkout or remote modification. No push, force push, tag, npm publish, GitHub Release, or real Tunnel/Store operations.

## Delivery / next action

The local fix commit containing this report is a **partial, blocked remediation**, not a release/sync approval. The exact public delta is only the seven paths and patch above. Revalidate it on native Linux x64 with approved Node, default workflow concurrency/timeouts and trusted local test storage; resolve the recorded remaining environment/timing failures without weakening safety assertions. Only then reconsider sync readiness under separate authorization.

**READY_FOR_PUBLIC_SYNC: NO**
