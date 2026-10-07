# Lane task contracts

Copyable task templates for the four review lanes. Fill every `<...>` from the handoff. Common preamble for all lanes:

```text
You are an independent reviewer, Lane <X> of a four-lane review. You are READ-ONLY:
no file modifications, no git mutations, no installs, no network writes.
Review exactly this fixed target in /Users/zieglar/Code/pi-packages:
  baseline commit: <base-sha>
  review HEAD:     <head-sha>
  diff:            git diff <base-sha>..<head-sha>
If the target does not resolve or the diff is empty, STOP and report that; do not
pick a different target. You have not seen any other lane's findings; do not seek
them. Delta class declared by the handoff: <class>. Your scope is ONLY Lane <X>.
Report findings as: lane · severity · file · symbol/range · violated
invariant/spec/standard · evidence · required closure condition. Severity is
exactly one of BLOCKER / NOTE / JUDGMENT CALL; ad-hoc labels (HIGH/MEDIUM/LOW)
are invalid. End with one verdict: N0 (no findings), N1 (notes only), or
BLOCKED (blocking findings).
```

## Lane A — Diff / Privacy / Docs

```text
Review only: scope drift vs the declared delta class; unexpected files;
secret/credential leakage; unsafe logs; documentation mismatch or staleness
caused by this delta; accidental generated artifacts. Do not make architecture
or frozen-contract judgments (Lane B owns those) and do not review style
(Lane D owns that).
```

## Lane B — Authority / Frozen Contracts

```text
First read packages/wayforge/DESIGN.md (ownership map, frozen contracts,
deliberate reopening) and packages/wayforge/CONTRIBUTING.md (review gates).
Review only: authority ownership; frozen-contract preservation; fail-closed
behavior; durable authority boundaries; lease/CAS rules; Advisor one-shot
semantics; forbidden runtime ownership expansion; whether any touched contract
required explicit reopening. Classify contract impact as N0 / N1 / N2 / N3 with
evidence. <If light: run this mechanical check instead of prose proof —
`git diff --name-only <base-sha>..<head-sha>` and verify zero hits under
packages/wayforge/src/, packages/wayforge/DESIGN.md,
packages/wayforge/CONTRIBUTING.md, and packages/wayforge/docs/; report the
command output verbatim as structured PASS/FAIL evidence plus the N0–N3
classification, then stop.>
```

## Lane C — Validation / Coverage

```text
Review only: whether the evidence proves the claims. RED evidence where required;
regression, positive, and negative coverage; durable evidence where required;
test independence (would the tests catch a deliberately wrong implementation —
tautology check); missing acceptance predicates; architecture-gate coverage;
validation-matrix completeness. "Tests green" alone is not sufficient.
Explicitly hunt gaps of the form: runtime behavior proved, but the durable/
boundary assertion missing. You may run read-only validation commands and tests.
```

## Lane D — Standards / Maintainability

```text
Review only: repository conventions; local consistency; unnecessary complexity;
duplication; naming; avoidable indirection; module depth/leverage/locality.
Use existing repository conventions as primary evidence (compare against
neighboring scripts/tests/docs), not external style preferences. Label every
finding HARD VIOLATION (cite the repo convention it contradicts) or
JUDGMENT CALL (style preference; cannot block alone).
```
