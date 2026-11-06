# GitHub Actions Efficiency Design

**Status:** Approved in current conversation on 2026-11-06.

## Scope and evidence

Target repository: `zieglar/pi-packages`, public `main` at `679a0bac356768ca5e44d09a6bb063e56ac16fbc`. CE #106 was not readable (`MESSAGE_READ_REJECTED`); implementation uses the explicit user requirements and approved revised design in the current conversation. Never push `main`, merge or release.

The last 50 workflow runs were requested; only 30 exist. Of these, 16 are CI runs. Queue-to-first-job P50/P90 is 2.5/3 seconds. Actual execution P50/P90 is 229.5/237.5 seconds. `validate` P50 is 229.5 seconds and its `Test` step P50 is 202 seconds. Latest successful main CI run 41335972248 reports 186 passed + 2 skipped test files and 206.82 seconds of test wall time. Dependency install takes about 2 seconds, so extra dependency caching is not an evidence-backed optimization. Only manual Native Release runs use macOS; they remain unchanged.

## Approved design

1. Preserve full test coverage with two independent jobs:
   - `validate-storage` invokes the existing `test:storage` command. It does not exclude `inbox-ack-volume.test.ts` or any additional file.
   - `validate-other` invokes `pnpm --dir packages/pi-chat-exchange test --exclude 'test/storage/**'`. Do not add a second standalone `--` after `test`; pnpm 12.9.1 would forward it as a literal argument.
   - Both jobs run the existing workspace checks, build, typecheck and package checks, then the bounded test subset with `CE_DEFAULT_CLIENT_GUARD=1` at job scope. No worker-count changes.
2. Preserve the observed `validate` check context with a lightweight aggregator requiring both shards. It always evaluates both results and exits nonzero unless both are `success`. It is not optional and cannot hide failures.
3. Use `github.sha` for the CI concurrency group: PRs share a PR-number group and can cancel stale runs; each main SHA has its own group with `cancel-in-progress: false`. Every main push gets complete checks even when pushes are consecutive. Release and publication workflows are not changed.
4. Do not add docs-only gating. A reliable full-diff classifier and terminal semantics for all required checks are not established in this task.
5. Add contract tests for the two commands, original exclusions and isolation guard, aggregator result propagation, and main/PR concurrency semantics. Update the existing tunnel-workflow assertion to the new architecture rather than removing it.

## Validation

- Confirm clean public baseline at the exact SHA and no unrelated worktree edits.
- Write contract assertions and run them to RED before editing CI.
- Run the two exact test commands with Node 24.21.0 and pnpm 12.9.1 after build. Record file counts and wall times separately. Compare collected files against the 188-file public baseline: storage 65, other 123, disjoint and complete.
- Run build, typecheck, package checks and focused workflow contract checks. Report any local concurrent/resource-sensitive failures accurately rather than hiding them.
- Commit only the CI workflow, its contract test and this design/evidence documentation.
- Push only `perf/ci-efficiency-01` to the public remote, then create the explicitly authorized Draft PR to trigger CI. No push to `main`, merge or release.
- Compare hosted job durations, test files/counts, queue, total runner time, cancellation and check contexts. Do not infer a speedup from aggregate test time alone. Evaluate further changes only from hosted evidence.
