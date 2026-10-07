---
name: wayforge-baseline-gate
description: Verify the git baseline a Wayforge handoff expects (branch, HEAD, upstream, ahead/behind, cleanliness, commit range) before starting work. Use at the start of any Wayforge handoff whose instructions name a starting baseline, and whenever a handoff says "verify the baseline".
---

# Wayforge Baseline Gate

Run the mechanical checker instead of verifying the baseline by hand:

```sh
cd packages/wayforge
node scripts/check-baseline.mjs \
  --branch <expected-branch> \
  --head <expected-sha> \
  --upstream <expected-upstream-ref> \
  --upstream-head <expected-upstream-sha> \
  --ahead <n> --behind <n> \
  --clean
```

Pass only the invariants the handoff actually states. Full flag reference: `node scripts/check-baseline.mjs --help`.

## Rules

- **PASS (exit 0):** the requested baseline holds; continue the handoff.
- **FAIL (exit 1):** STOP. Do not reset, stash, revert, clean, or overwrite anything. Report the failing invariant, expected, and actual to the operator.
- **Exit 2:** usage or environment error (not a baseline verdict); fix the invocation.
- Expected values always come from the handoff in front of you. The checker enforces supplied expectations; it never invents them.
- The checker is strictly read-only. It does not fetch: if the handoff authorizes a network refresh, run `git fetch` yourself first, then re-run the checker.
- Untracked files never fail `--clean`; they are reported in the output. Allowed untracked/dirty exceptions stay explicit in the handoff text.

## What PASS does NOT authorize

A passing baseline authorizes only the named starting state. It does not authorize pushing, fetching, tagging, branching, committing, or touching frozen contracts — those stay explicit per handoff.
