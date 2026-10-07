---
name: wayforge-release-gate
description: Verify Wayforge release eligibility, exact authorized commit ranges, post-push identity, and exact-SHA hosted CI without acquiring push or tag authority. Use for pre-push, push, post-push, CI, or milestone-closure handoffs.
---

# Wayforge Release Gate

The release gate answers **"is the state eligible for the explicitly authorized action?"** It never answers **"is mutation authorized?"**

```text
eligible ≠ authorized
Can the release gate authorize push?  NO
Can it authorize tags?                NO
Can it determine eligibility?         YES
What authorizes mutation?              Current explicit handoff/user authority
```

The helper is strictly read-only. Full flags: `cd packages/wayforge && node scripts/check-release.mjs --help`.

## Required dynamic inputs

The current handoff must state every release-specific value: authorized base/head/ordered commits; expected branch/remote/upstream; push authorization; tag authorization; remote-refresh authorization and freshness requirement; review/validation status; required CI workflow/event/branch; scope-specific stop conditions. Do not hide these in skill defaults.

Absent push authorization means **VERIFY ONLY**. Tag authority is separate and defaults false: never infer it from push authority, eligibility, CI success, branch name, or previous releases.

## Phases

### 1. PRE-PUSH

1. Obtain P0 review and PASS validation evidence from the current handoff/run.
2. If fresh remote state is required, fetch **only when this handoff explicitly authorizes remote refresh**. The helper never fetches. Record remote state as `fresh` only after that authorized refresh; otherwise use `existing`.
3. Run the helper with all dynamic inputs and the exact ordered authorized commits:

```sh
cd packages/wayforge
node scripts/check-release.mjs pre-push \
  --repo <repo> --branch <branch> --head <head-sha> \
  --upstream <remote-ref> --upstream-head <upstream-sha> \
  --ahead <n> --behind <n> --base <base-sha> \
  --authorized-commit <oldest-sha> [--authorized-commit <next-sha> ...] \
  --review-status P0 --validation-status PASS \
  --remote-state <fresh|existing> --require-fresh <true|false> \
  --push-authorized <true|false> --tag-authorized <true|false>
```

The helper composes `check-baseline.mjs` for branch/HEAD/upstream/ahead/behind/cleanliness, then adds exact ordered range and ancestry proof. Count alone is never sufficient. Any failure → STOP. A PASS means eligible only.

### 2. PUSH

The helper never presents, prepares, or executes a push — it is read-only in all modes. Push happens only when `push_authorized=true` came from the current handoff, and even then authority is external: the caller performs the exact handoff-authorized normal fast-forward push.

Allowed only when explicitly authorized: expected remote + expected branch + already-verified range. Never introduce force/force-with-lease, rebase, amend, squash, unexpected branch/refspec, or implicit tag operations. If the upstream moved after PRE-PUSH, STOP — do not reconcile automatically.

### 3. POST-PUSH

Use `wayforge-baseline-gate` rather than duplicating git-state parsing:

```sh
cd packages/wayforge
node scripts/check-baseline.mjs \
  --branch <branch> --head <pushed-sha> \
  --upstream <remote-ref> --upstream-head <pushed-sha> \
  --ahead 0 --behind 0 --clean
```

Require local HEAD = remote-tracking branch = exact pushed SHA, 0/0, clean.

### 4. HOSTED-CI

Locate/query runs with `gh` or the repository-supported API, then save authoritative JSON containing `workflowName`, `event`, `headBranch`, `headSha`, `status`, and `conclusion`. Classify only an exact identity:

```sh
cd packages/wayforge
node scripts/check-release.mjs ci \
  --evidence <run-json> --workflow <workflow> --event <event> \
  --branch <branch> --head <exact-pushed-sha>
```

Evidence rules:

- **CI-PASS:** exact workflow/event/branch/SHA; terminal `completed`; conclusion `success`.
- **CI-IN-PROGRESS:** exact identity; authoritative run status is non-terminal.
- **CI-MISSING:** no run matching all four identity fields after the handoff's search window.
- **CI-FAIL:** exact terminal non-success plus inspected job evidence showing milestone-caused failure; rerun classifier with `--failure-kind milestone`.
- **CI-INFRA:** exact terminal non-success plus inspected job evidence showing external/infrastructure cause; rerun with `--failure-kind infrastructure`.

Never accept latest-success, branch-only success, previous SHA, or a manual run for another commit.

**Watcher timeout is not CI failure.** When a local watcher expires, query authoritative hosted state again. Classify that state: completed success/failure, still in progress, or missing. Harness timing never becomes release/product evidence.

### 5. CLOSED

Closure requires PRE-PUSH eligibility, externally authorized mutation (if any), POST-PUSH identity, and exact-SHA hosted-CI classification required by the handoff. A gate never upgrades eligibility into push/tag/release authority.

## Tag boundary

`push_authorized` and `tag_authorized` are independent. Default tag authority is false. Do not create or push any tag unless the current handoff explicitly authorizes the exact tag name, target, and operation. This skill/helper never creates or pushes tags.
