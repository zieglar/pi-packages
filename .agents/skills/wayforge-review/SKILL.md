---
name: wayforge-review
description: Run a four-lane independent review of a Wayforge delta (diff/privacy/docs, authority/frozen contracts, validation/coverage, standards/maintainability) with a fixed review target and parent synthesis. Use whenever a handoff asks for a milestone review, delta review, or independent review of Wayforge work.
---

# Wayforge Four-Lane Review

Independent parallel lanes, fixed review target, parent synthesis. This skill encodes the protocol; lane task templates live in [references/lane-contracts.md](references/lane-contracts.md). Authority contracts are **not** duplicated here — Lane B reviewers read the authoritative sources: `packages/wayforge/DESIGN.md` (ownership map, frozen contracts, deliberate reopening) and `packages/wayforge/CONTRIBUTING.md` (review gates, scope classification).

## 1. Fix the review target first (mechanical)

Before spawning any lane, capture from the handoff: baseline commit, review HEAD, exact range. Then:

```sh
cd packages/wayforge
node scripts/check-baseline.mjs --head <review-head> --clean-worktree --clean-index
git rev-list --count <base>..<review-head>   # must be > 0; empty diff = STOP, report to operator
```

After all lanes return, re-run the same `check-baseline.mjs` invocation. If it fails, the review target moved: the review is **invalid** — STOP, report `REVIEW TARGET MOVED`. Never review a moving target; never switch targets silently.

## 2. Applicability (deterministic)

The handoff declares the delta class. **Verify the declared class mechanically before accepting it:**

```sh
git diff --name-only <base>..<review-head>
# runtime authority change → any hit under packages/wayforge/src/
# docs-only                 → only *.md files
# workflow tooling          → only scripts/, test/, .agents/, package.json script entries
```

If the declared class was not verified this way, or the diff does not match it, use **all four lanes**. Do not self-select out of a lane.

| Delta class | Lanes |
|---|---|
| Runtime authority change | A + B + C + D |
| Test-only acceptance hardening | A + B(light) + C + D(light) |
| Docs-only | A + D; B only if frozen-contract language touched; C only if validation claims changed |
| Workflow tooling (scripts/skills, no `src/`) | A + C + D + B(light to prove runtime/frozen contracts untouched) |

"(light)" = the lane runs, scoped to confirming non-impact; it may not be skipped. Lane B(light) is a mechanical check, not prose: run `git diff --name-only <base>..<head>` and prove zero hits under `packages/wayforge/src/`, `packages/wayforge/DESIGN.md`, `packages/wayforge/CONTRIBUTING.md`, and `packages/wayforge/docs/`; report the command output as structured PASS/FAIL evidence plus the N0–N3 classification.

## 3. Spawn lanes

One fresh-context subagent per lane, run in parallel. Lanes must not see each other's findings or any prior review's conclusions — give each lane only: the fixed target (base/HEAD/range), its lane scope, the finding format, and the decision vocabulary. Lane task templates: [references/lane-contracts.md](references/lane-contracts.md). Pin explicit model routes per handoff; record provenance; quota failure is infrastructure, not a finding.

## 4. Lane scopes

- **Lane A — Diff / Privacy / Docs:** scope drift, unexpected files, secret/credential leakage, unsafe logs, documentation mismatch or staleness caused by the delta, accidental generated artifacts. Not architecture judgment (that is Lane B).
- **Lane B — Authority / Frozen Contracts:** authority ownership, frozen-contract preservation, fail-closed behavior, durable authority boundaries, lease/CAS, Advisor one-shot, forbidden runtime ownership expansion. Classify contract impact: **N0** none · **N1** contract-consistent, no reopening · **N2** frozen-adjacent, requires explicit evidence · **N3** frozen contract touched, requires explicit reopening per DESIGN.md. Authoritative sources: DESIGN.md + CONTRIBUTING.md.
- **Lane C — Validation / Coverage:** does the evidence prove the claims? RED evidence where required, regression/positive/negative coverage, durable evidence where required, test independence (tautology check), missing acceptance predicates, gate coverage, validation-matrix completeness. "Tests green" alone is never sufficient. Explicitly hunt 92847-type gaps (runtime behavior proved, durable assertion missing).
- **Lane D — Standards / Maintainability:** repository conventions, local consistency, unnecessary complexity, duplication, naming, avoidable indirection, module depth/leverage/locality. Every finding is **HARD VIOLATION** (contradicts an existing repo convention — cite it) or **JUDGMENT CALL** (labeled; never a blocker alone). Repo conventions are primary evidence; external generic style is secondary.

## 5. Finding format (blocking findings)
Every finding carries exactly one lane-level severity: **BLOCKER** / **NOTE** / **JUDGMENT CALL**. Ad-hoc labels (HIGH/MEDIUM/LOW, etc.) are invalid. Lane D additionally marks each BLOCKER as a HARD VIOLATION (citing the repo convention it contradicts). Lane verdicts remain N0 / N1 / BLOCKED. Parent-level decisions (P0, P1/…) belong to synthesis only (§7).

`lane · severity · file · symbol/range · violated invariant/spec/standard · evidence · required closure condition`. Vague findings ("needs cleanup", "could be better") are invalid; judgment calls must be labeled JUDGMENT CALL.
## 6. Parent synthesis (after all lanes return)
The synthesis must be emitted as a structured artifact (a `parent-synthesis.md` file alongside the lane outputs — not a free-form reply) containing: the fixed target and its pre/post verification, the lane verdicts, deduplication, blocker ranking, any surfaced disagreement, and the final decision.

May: deduplicate identical evidence, rank blockers, resolve scope/applicability, produce the final decision. Must not: erase disagreement, downgrade a supported blocker without explanation, merge distinct authority and standards findings, or invent evidence the lanes did not produce. Material disagreement between lanes is surfaced, not resolved by fiat.
## 7. Decision vocabulary (existing process, unchanged)

- **P0** — approved to proceed (push/close as the handoff specifies)
- **P1 / PRODUCT** — blocked on a product/standards hard violation
- **P1 / VALIDATION** — blocked on insufficient evidence
- **P1 / INFRASTRUCTURE** — blocked on environment/tooling, not findings
- Lane B contract impact rides alongside: N0/N1/N2/N3

Lane D interaction: HARD VIOLATIONs block as P1 / PRODUCT unless the operator explicitly waives; JUDGMENT CALLs are recorded as notes and never change the verdict alone.
