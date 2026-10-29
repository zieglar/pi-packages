[English](ph0003-validation.md) | [简体中文](ph0003-validation.zh-CN.md)

> Historical evidence or design record. Claims, commands, test results and limitations below describe the recorded phase, not current support or release eligibility.

# PH-0003 validation, review and acceptance boundary

## Baseline and separately authorized correction

Initial baseline verified before work: `<repository-root>`, `main`,
`5a84cb1721d87a6f324d4d288ce0beac3dda1579`, clean. No push.

Before convergence, a frozen-contract conflict was reproduced: owner-abandonment
text licensed UNKNOWN→CANCELLED→normal CLOSED while transport remained ambiguous.
Minimal RED: 1 failure. Work stopped, temporary reproduction removed, clean
baseline restored and owner authorization awaited. The owner explicitly approved
a separate correction; commit `8f44553d21df67211774ace9702bdb3aa7802db7` fixes
cancellation consistency and adds administrative ABANDONED_UNRESOLVED disposition,
not a new runtime outcome or ordinary close path. Hotfix GREEN: 131/131 tests,
13 files; Wayforge 438/438. Full RED details/root cause/limitations remain in
`quarantine-hotfix-ph0003.md`. Its identities, corrected factual evidence rules
and disposition semantics were preserved during convergence.

## Audit and approved design

Four actual bridge source trees, their full licenses and two material official
protocol references were inspected. Both TS and CJS entrypoints of ChatGPT-Bridge
were audited. Exact pins/source handles/limits and capability matrix are durable
in `chat-bridge-audit-ph0003.md`; PH-0002 Pi-side evidence was compared, not repeated.
All third-party verdicts are REFERENCE_ONLY; no external code/dependencies or
private/runtime integrations were introduced.

Owner approved design C: ControlSurface + capability-oriented Endpoint integration.
The plan is `plans/2026-10-06-endpoint-convergence.md`. Literal client/agent authority
was replaced, not merely renamed. Plain host contexts bind independent actions to
principal and exact Exchange/Message/Attempt/destination/owner scopes. Declarations
and missing support cannot manufacture evidence. No authentication service exists.

## RED → GREEN

- Scoped-authority behavior RED against the old roles: **8 failed / 8 passed**,
  `/tmp/ph0003-convergence-red.log`. Positive exact-scope transitions failed on
  the old role requirement; the role-only negative exposed its intended rejection
  under the new approved authority contract. No import errors counted as behavior RED.
- Capability-declaration RED: **2 failed**, absent exported contract assertions,
  `/tmp/ph0003-capabilities-red.log`; these were contract-availability assertions,
  not claims that runtime evidence was synthesized by the old core.
- Architecture RED: the old gate failed to reject a future conversation endpoint's
  MCP SDK import (`0 violations`), `/tmp/ph0003-layer-red.log`. Updated plane/endpoint
  gates reject it, with control↔endpoint and inter-endpoint fixtures.
- Request-only guard type RED: tsc rejected omission of a lease in two calls
  (`/tmp/ph0003-request-lease-type-red.log`). The lease field is now optional
  ONLY at the input-type level: request-only moves need no fabricated lease;
  attempt-backed moves still validate and require real lease evidence. A positive
  request and negative runtime assertion verify that distinction.
- Final GREEN: **155/155 tests in 15 files**, including all retained identity,
  lifecycle, immutable/read, cancellation, quarantine/disposition, idempotency,
  mandatory built stdio/in-memory ping and compile-negative assertions.
  New tests cover independent grants, foreign scopes/principals/incarnations,
  owner versus runtime permission, malformed/opaque contexts, reconciliation,
  missing evidence despite support, multiple grants for one peer, reverse messages,
  reply versus Result and quarantine across endpoint kinds.
- **14/14 negative fixtures rejected**; strict `tsc --noEmit` and build pass.
  Build output was cleaned before final verification; no stale old-adapter outputs
  were used by smoke tests.
- Wayforge: **438/438 tests, 51 files**, terminal exit 0, background task
  `<validation-task>`, log `/tmp/ph0003-final-wayforge.log`; source diff empty.
- Workspace gate and format/diff-whitespace checks pass. Active LSP check: 6 paths,
  0 errors, 4 confirmed clean and 2 inconclusive. Full tsc is the complete evidence,
  not a claim of six LSP-confirmed clean files.
- Parent TypeScript-AST comparison confirms every corrected transition edge and
  lease/evidence requirement matches hotfix HEAD. Entity, identity, outcome,
  idempotency and reference-store source files have no convergence diff.

Commands (pnpm 12.9.1 through mise):

```sh
mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange run verify
mise x pnpm@12.9.1 -- pnpm --filter wayforge test
node tooling/check-workspace.mjs
mise x pnpm@12.9.1 -- pnpm run format:check
```

Convergence was executed and full-diff reviewed directly by the parent after design
approval; no independent child review of this final tree is claimed. The previous
PH-0002 delegation cap was respected. Actual convergence SHA and clean committed
worktree are recorded in the final PH-0003 report, separate from the hotfix.

## Acceptance limit

READY for a neutral transactional durable-core repository and restart/crash tests;
no remaining architectural convergence blocker. This does not establish a supported
ChatGPT conversation delivery API or real Desktop acceptance (NOT_RUN).

The future host must authenticate identities, load owner/endpoint/consumer bindings,
current grants, full authoritative snapshots/claims/disposition, enforce admission
and evidence provenance and atomically check-and-commit. Immutable publication and
availability transitions must be checked together against authoritative settlement.
Missing observations remain unknown; unsupported workflows cannot fabricate proof.
Persistence, CAS, fencing allocation and authentication are not implemented here.
No delivery, SQLite/store, broker/network, daemon, tunnel/browser/CDP/private API,
full MCP operation or production configuration change was started. No changes to
Wayforge, production Pi, Moshi, Herdr or pi-web. No push or historical amend.
