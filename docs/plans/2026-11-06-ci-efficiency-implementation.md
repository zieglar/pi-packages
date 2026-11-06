# GitHub Actions Efficiency Implementation Plan

> **For Pi:** Execute the approved design in this worktree, task-by-task, using test-driven development and review checkpoints.

**Goal:** Preserve all current checks while reducing CI's test critical path and ensuring every main commit receives a complete run.

**Architecture:** Two complete and disjoint Vitest lanes run in parallel; a stable `validate` aggregator preserves the observed check context. PR cancellation remains enabled, but main concurrency groups are SHA-specific and never cancel. No docs-only classifier, matrix reduction or Release changes.

**Tech Stack:** GitHub Actions YAML, pnpm 12.9.1, Node 24.21.0, Vitest 4.1.11, Node's built-in test runner.

### Task 1: Contract RED

**Files:** `packages/pi-chat-exchange/scripts/test/tunnel-workflow.check.mjs`

Add assertions that:
- `validate-storage` runs `pnpm --dir packages/pi-chat-exchange run test:storage`, and `validate-other` runs `pnpm --dir packages/pi-chat-exchange test --exclude 'test/storage/**'`.
- Both jobs have `env.CE_DEFAULT_CLIENT_GUARD === '1'`; neither excludes `inbox-ack-volume` or sets arbitrary worker limits.
- Both retain build, typecheck, package checks and workspace validation.
- `validate` requires both shards and explicitly rejects any non-success result while running under `always()`.
- Concurrency uses `${{ github.event.pull_request.number || github.sha }}` and `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`.
- Native, tunnel and Release contracts remain unchanged.

Run `node --test packages/pi-chat-exchange/scripts/test/tunnel-workflow.check.mjs` and retain expected failure evidence.

### Task 2: Minimal workflow GREEN

**Files:** `.github/workflows/ci.yml`, `packages/pi-chat-exchange/scripts/test/tunnel-workflow.check.mjs`

Implement only the approved design. Run the contract and compatibility checks again. Do not change package scripts or test contents.

### Task 3: Local coverage and timing

Use the exact two job commands with Node 24.21.0, after a successful build, and separately capture file sets, file/test counts and elapsed time. Verify 65 + 123 = 188 files, no overlap, and all `inbox-ack-volume` cases present. Investigate any failures against the public baseline rather than claiming an optimization.

### Task 4: Review, local commit and authorized hosted evidence

Review the frozen delta with `security-reviewer` using `magpie/group/expert` and `high` thinking. Parent evaluates findings and reruns affected tests. Commit only scoped files, push `perf/ci-efficiency-01` to `https://github.com/zieglar/pi-packages.git`, and create the authorized Draft PR. Do not push `main`, merge, release or change external settings.

Compare hosted durations and full test coverage against baseline. Use subsequent actual runs for second-pass optimization only; do not add unmeasured changes.

### Task 5: Hosted measurement and stop decision

Draft PR [#5](https://github.com/zieglar/pi-packages/pull/5), run [42157813962](https://github.com/zieglar/pi-packages/actions/runs/42157813962), passed all jobs at implementation commit `9dd99d861534c99f2015abe9e363d030081b5a13`.

- Coverage matched main run 41335972248 exactly: 186 passed + 2 skipped files and 2958 passed + 26 skipped tests. The storage lane ran all four `inbox-ack-volume` cases.
- The test critical step decreased from 208s to 136s (34.6%). The complete job span decreased from 236s to 168s (28.8%); queue to the first job was 3s versus 2s.
- `validate-storage` took 99s, `validate-other` 162s and the successful stable `validate` aggregator 4s. Native and pinned Tunnel compatibility lanes passed.
- Summed runner time increased from 467s to 499s (6.9%) because setup/build/typecheck intentionally run in both shards and the aggregator uses a runner.
- One hosted sample is not a new P50/P90. A documentation-only follow-up commit repeats the same workflow and test code to check stability; no further partitioning, caching or worker tuning is justified by the current evidence.
