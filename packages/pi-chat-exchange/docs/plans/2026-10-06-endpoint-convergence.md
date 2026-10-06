# PH-0003 Endpoint Convergence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Freeze ControlSurface + capability-oriented Endpoint integration without implementing delivery or persistence.

**Architecture:** The owner approved option C after source-level comparison. Control surfaces expose request/read/administrative operations; endpoint integrations supply only supported delivery/runtime evidence. Neither an interface nor capability advertisement authorizes an action: the future authenticated host supplies principal-bound action grants with exact scopes and authoritative transaction snapshots.

**Tech Stack:** Existing strict TypeScript, TypeBox, Vitest, TypeScript-AST architecture gate; no added dependencies.

## Approved design

Retaining literal client/agent authorities would misclassify peers. Simply renaming both adapters would conflate API invocation with delivery to an addressable conversation. Thus separate `control/mcp` from `endpoints/pi`, leaving generic `protocol` and `core` inward of both. There is no ChatGPT endpoint implementation, placeholder, daemon or private API integration.

Keep all Exchange/Message/Result schemas and wire identities. Follow-ups and replies are independently routed Messages within an Exchange. A Result is immutable processing evidence, never an automatically sent reply. Preserve the separately approved quarantine/disposition hotfix: unresolved administrative archival records ambiguity, does not normally close the Exchange or manufacture cancellation/settlement.

Declare delivery, observation, cancellation, follow-up and result-production support independently as supported/unsupported/unknown. Optional/missing support means unknown, not proof. Actual correlated evidence is required by the existing core rules. Confirmed transport with unobservable execution must not be falsely reclassified as delivery ambiguity.

Replace client/agent discriminants with closed action names and these grant scopes:

- exchange send/get/result: exact Exchange;
- listing: collection (future host still filters authorized records);
- cancellation request: exact Exchange and Message;
- claiming: exact Exchange, Message and destination endpoint;
- dispatch, delivery, runtime progress/settlement, result publication, lease release, reconciliation and cancellation confirmation: exact Exchange, Message, Attempt and recipient incarnation;
- close/archive: exact Exchange and owner principal, separate grants.

A transition may require more than one grant: delivery reporting alone cannot assert acceptance; ambiguity reconciliation alone cannot supply runtime acceptance. Runtime cancellation confirmation requires runtime reporting authority as well as cancellation confirmation; a proven never-attempted cancellation does not invent runtime evidence. Granted scope never replaces leases, fencing or factual evidence. Contexts are plain contracts, not cryptographic tokens. Only the future host may construct trusted contexts after authenticating the actual adapter/runtime and loading grants, active claims/attempts/disposition/all messages transactionally. No authentication implementation or caller-issued security boundary is claimed.

## Task 1 — RED authority and capability regressions

Create `test/core/endpoint-authority.test.ts` and `test/protocol/endpoint-model.test.ts`. Exercise real transitions with new contexts against the old role guards, plus rejection of literal roles, cross-message/attempt/instance/principal scope, unrelated grants, owner/runtime escalation and evidence missing despite advertised capability. Test reversed Message routing, independent reply/Result, non-mutating reads, explicit close and fail-closed quarantine across endpoint kinds. Positive tests must fail under the old contract; do not count import errors as behavior RED.

Run:
`mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange exec vitest run test/core/endpoint-authority.test.ts test/protocol/endpoint-model.test.ts`
Save the failure output under `/tmp/ph0003-convergence-red.log`.

## Task 2 — Small authority migration

Rewrite `src/protocol/capabilities.ts` into closed control/endpoint catalogs plus typed, schema-validated action grants/context. Add pure `src/core/authorization.ts` matching exact principal/action/scope; reject malformed/non-JSON contexts. Add `src/protocol/endpoint-capabilities.ts` for declarations only. Update `src/protocol/lifecycle.ts` requirements to action arrays and `src/core/rules.ts` to check scoped grants before existing proof checks. Add scoped authorization to immutable publication; keep pure non-mutating read validation separate. Bind archive owner intent to its authorized principal. No changes to lifecycle edges, identity generation or runtime semantics.

Update existing test fixtures to supply explicit trusted-test contexts; retain every existing behavioral assertion. Replace role compile-negatives with operation/scope and control/endpoint negative contracts. Confirm RED tests GREEN before layer relocation.

## Task 3 — RED physical-boundary fixtures, then move

Add meaningful fixtures for core→control, protocol→endpoint, MCP control→Pi endpoint, Pi endpoint→MCP control, future ChatGPT endpoint→MCP SDK/control. Prove the old gate fails to reject these new-role paths before updating it. Move with Git:
`src/adapters/mcp/*` → `src/control/mcp/*`;
`src/adapters/pi/contract.ts` → `src/endpoints/pi/contract.ts`;
MCP tests → `test/control/mcp/*`.
Update bin imports, fixtures, gate path predicates and Pi declaration; no new endpoint code. Enforce all control↔endpoint and inter-endpoint dependencies transitively, including barrels; protocol/core cannot reach outer layers or bin; endpoint code cannot depend on MCP SDK. Keep mandatory ping smoke unchanged in behavior.

## Task 4 — Durable audit and corrected docs

Create `docs/chat-bridge-audit-ph0003.md` from `/tmp/ph0003-source-audit/audit-findings.md`, retaining exact pins, licenses, source handles, negative findings and the two material official references. Update active README/architecture/protocol/adapter docs. Preserve PH-0001/2 evidence and hotfix history with supersession banners, not rewritten historical claims.

## Task 5 — Verification, review, one convergence commit

Run package verify (gate + negative fixtures + tsc + build + all tests), workspace check, format/diff checks; run Wayforge regression in background and inspect terminal exit/count before completion. Review full diff, assure no forbidden source/config changes or dependencies. Commit only scoped package changes; do not amend earlier commits or push. Verify committed tree and clean worktree. Record separate hotfix and convergence commits in the exact PH-0003 report.

Stop and report rather than silently fix any newly falsified frozen contract. No durable implementation starts in this phase.
