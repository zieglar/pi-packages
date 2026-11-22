# CE 0.4.0 local test repair

The default CE test lane is healthy: **3,913 tests, 3,895 passed, 0 failed, 18 existing skips**. The candidate remains unreleased and lacks Hosted/Cloud qualification.

This follow-up starts at `candidate/ce-0.4.0` commit `59e71d139259d12eec923d032663651a2926d21c`. The original [candidate report](2026-11-22-ce-040-candidate.md) and [98-case classification](2026-11-22-ce-040-failure-classification.json) remain historical evidence, including their original failed observations. They are not rewritten as successful runs.

## Production corrections

1. `session_shutdown` used to await reload pairing inspection before closing the old generation. A reentrant inbox read could publish a result after teardown began, and an outstanding confirmation could continue into a binding change. Shutdown now closes admission, timers and pending confirmations synchronously before pairing inspection can yield. Existing runtime-replacement and deactivation-teardown negative tests reproduced the failures and now pass. Owner, Session, fencing, capability and recovery assertions remain intact.
2. Stop during a pending Connect/Disconnect task previously entered the old busy-operation branch and called the real background manager's `stop()`. A new regression reproduced the call. Real Stop now cancels the local pending dialog and joins it while retaining Homebrew/launchd ownership of the shared service. It does not call the real manager's stop or release a binding after cancelled Disconnect confirmation. Offline simulator Stop still runs and reports its actual activity.

These changes enforce the existing lifecycle and system-service contracts. They add no grants, automatic recovery, takeover or transport-control authority.

## Closure of the original 98 failures

| Confirmed cause / treatment | Original failed cases |
|---|---:|
| Incomplete whole-module fs mocks: preserve real fs/security exports, intercept only operator allowlist and synthetic Store existence | 45 |
| Heartbeat assertions and IPC checkpoints counted unrelated connectivity timers: track actual renewal handles/callbacks; retain durable revision/fencing and full-shutdown assertions | 25 |
| Runnable Hook fixtures omitted the now-required session scope | 4 |
| Real Tunnel command tests expected obsolete daemon control: verify advisory real commands, Native revalidation and real offline Stop activity | 9 |
| Reload continuation fixtures lacked coherent policy identity/exchange/store and released-session history | 2 |
| Reproduced shutdown-before-await race, fixed in production | 2 |
| Desktop feedback fixtures omitted the current authoritative native-session owner binding: construct valid private configuration and retain BLOCKED/no-owner negatives | 2 |
| Outdated exact UI/save-mode/status expectations | 2 |
| Immutable-ACL fixtures repeatedly spawned macOS ACL probes: snapshot each actual OS reply within that private fixture, retaining real file stats and policy reads | 5 |
| Version expectations already corrected in the starting candidate | 2 |
| **Total** | **98** |

Thus this leg closes 94 original failures through test maintenance and two through the production shutdown correction; the two version cases were already corrected at the fixed baseline. The real Stop correction adds a regression beyond that original inventory. Three new cases account for the suite count increasing from 3,910 to 3,913: pending Disconnect/real Stop, ordinary intake without a Desktop owner, and real Stop without simulator activity.

No new skip/only, deleted valid test, raised timeout, arbitrary delay, swallowed exception or weakened permission negative was introduced. Obsolete command scenarios were revised to the current contract, including exact refusal/guidance, no prompt, no process and no persistence assertions.

The ACL snapshot helper is test-only and used only in three fixture groups that never mutate ACLs. It reuses actual replies per path, not synthetic permission decisions; it does not cache policy bytes, mode/owner/link stats or production reads. Dedicated ACL tests do not use it. A CPU profile identified `execFileSync → /bin/ls -lde` as the dominant repeated cost. The original five deadline observations remain in raw evidence; default test timeouts are unchanged.

Intermediate fixture failures are retained too: an initial snapshot wrapper captured an existing spy and recursed on a second fixture; it now captures the callable implementation and restores spies. A missing `vi` import in cleanup was also fixed. These were test-maintenance mistakes, not additional production defects.

## Full default run

Environment: macOS arm64, Node **24.21.0**, explicit isolated `node:sqlite` selection from the existing Vitest configuration. Default installed-client spawn guard enabled. Full run wall time was 619.62 seconds.

```sh
PATH=/path/to/node/24.21.0/bin:$PATH pnpm --dir packages/pi-chat-exchange test \
  --maxWorkers=2 --reporter=json --outputFile=/private/evidence/full-final.json
```

Actual result: `success=true`, 3,895 passed, zero failed, 18 skipped, zero failed suites. Root-cause groups were tested before the complete run. Necessary compiler, build, CE contract/Native packaging checks and workspace checks passed. Active LSP probing reported no cached errors in four diagnosed changed paths; it is supplementary evidence, not a claim of complete editor coverage. Existing AST/style findings and the three default-client-guard mock-hoisting warnings were not expanded into unrelated cleanup.

## The same 18 skips

| Existing condition | Count | Reason |
|---|---:|---|
| Desktop plugin artifact opt-in | 4 | `CE_PLUGIN_PACKAGE_TEST` is not set in the default lane; artifact checks run separately when validating the changed candidate |
| Native install/readiness fixture | 2 | `CE_TEST_NATIVE_MODULE` not set |
| Published Native default artifact fixture | 7 | Same explicit Native fixture prerequisite |
| Unsupported Node refusal fixture | 4 | `CE_TEST_UNAPPROVED_NODE` not set |
| Wrong-file-owner case | 1 | Requires root/chown authority; current user is not root |

The skip names and reasons match the original run exactly. No broader platform, privilege or Native qualification is inferred. Desktop Python runtime is unchanged; the existing 323-pass evidence is reused.

## Runtime and delivery evidence

Current runtime SHA-256: `a8a36b992d7ca6dc335344f0fd4492db29b7cb37268a03502cf9d0b908ec597e`.

The exact official Tunnel 0.0.21 binary was reused after rechecking its SHA-256. Local profile, health, normal Stop, abnormal child exit, failure Stop, cleanup and namespaced synthetic profile checks passed again on this digest. Qualification was performed from a modified worktree based on `59e71d13`; the delivery receipt binds the later commit to this same digest. The matrix still declares 0.0.20 as its CI/release baseline, with `ciVerified=false` for this 0.0.21 local observation. No Hosted or real Cloud run was attempted.

The final canonical package, independent Desktop ZIP and exact Pi install/PTY receipts are recorded with their actual identities in the local delivery receipt. Raw full-suite, profile, interim failures, subgroup results and official-client records are preserved privately in `.git/ce-040-test-repair/`; they are not packaged as payload or called Hosted evidence.

All tracked changes stay within `packages/pi-chat-exchange/`. Original development WIP (149 paths, including intentional deletions), the 20 transferred independent WIP files and development main are preserved. No push, merge, reset, rebase, cherry-pick, release, release-repository edit or production CE/Pi/Tunnel restart occurred.

Remaining release work: exact-candidate Hosted validation, the declared-client policy decision and matching reviewed real Cloud evidence, followed by separately authorized publication/production adoption. The required default local test debt is closed.
