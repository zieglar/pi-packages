[English](quarantine-hotfix-ph0003.md) | [简体中文](quarantine-hotfix-ph0003.zh-CN.md)

> Historical evidence or design record. Claims, commands, test results and limitations below describe the recorded phase, not current support or release eligibility.

# PH-0003 authorized quarantine/disposition hotfix

## Frozen-contract conflict and approval

Baseline: `main`, `5a84cb1721d87a6f324d4d288ce0beac3dda1579`, clean.
PH-0003 required preserving that cancellation cannot erase ambiguity. The
baseline deliberately allowed `DELIVERY_UNKNOWN -> CANCELLED` on client
owner-abandonment plus reconciliation text alone. `CANCELLED` was a finished
state, so `closeExchange` subsequently permitted CLOSED while the attempt
still recorded transport `ambiguous`. The owner explicitly rejected this
exception and authorized a separate bounded correction, followed by resuming
endpoint convergence. PH-0002's earlier acceptance is not acceptance of this
exception after that explicit amendment.

## RED evidence and root cause

Original minimal regression, before edits:

```text
transition: CANCELLED
exchange: CLOSED
recordedTransport: ambiguous
1 test failed: expected CANCELLED to be DELIVERY_UNKNOWN
```

The retained test is `test/core/ph0003-quarantine-stop.test.ts`; its fixture
is preserved and the corrected assertion requires `IllegalTransitionError`.
Original reproduction and log were retained at
`/tmp/ph0003-source-audit/ph0003-quarantine-stop.test.ts` and
`/tmp/ph0003-quarantine-stop-red.log`. The temporary test was removed and the
baseline was verified clean before waiting for authorization.

Root cause: `TRANSITION_REQUIREMENTS["DELIVERY_UNKNOWN>CANCELLED"]` used
`owner_abandons`; `assertEvidence` checked only existence of
`ReconciliationEvidence`. Its `{ resolvedAt, basis }` fields are investigation
metadata, not correlated no-effect or runtime-cancellation proof. Intent was
laundered into an execution-terminal state and then normal close eligibility.

Approved regression RED: **20 failed / 35 passed**, four targeted files,
before production edits (`/tmp/ph0003-hotfix-red.log`). Administrative API
contract assertions failed because its pure functions were absent; the
original transition/lifecycle assertions failed against the actual loophole.

The requested wider cancellation review also exposed contradictory facts:
`dispatch = not_attempted` could override a non-pending transport outcome in
safe cancellation/requeue; runtime cancellation did not require a consistent
started attempt; queued cancellation ignored presented started/ambiguous
proof. Additional RED: **5 failed / 1 passed**
(`/tmp/ph0003-cancellation-consistency-red.log`). These checks are corrected
within the authorized cancellation/quarantine scope, not a new implementation
phase.

A new-helper boundary regression additionally caught null attempt dereferencing
before validation (RED: 1 failed/17 passed). Validation now precedes access and
rejects malformed snapshots through `ExchangeDispositionError`.

## Corrected execution semantics

- Remove `owner_abandons` and entirely prohibit UNKNOWN→CANCELLED. The current
  evidence vocabulary does not establish a safe direct route. No adapter,
  owner or reconciliation text can grant this transition.
- Keep UNKNOWN→ACCEPTED/FAILED only through their existing correlated factual
  evidence and explicit reconciliation. No requeue/retry exit exists.
- A no-attempt cancellation/requeue must have both `not_attempted` and
  `pending`, with the existing authoritative fencing checks.
- Runtime cancellation needs a started/delivered attempt plus independently
  correlated runtime `cancelled` proof. That proof establishes cancellation,
  not absence of prior side effects or application success.
- Queued cancellation rejects contradictory dispatch evidence when presented.
  The future host must supply authoritative state and complete attempt data;
  omission by an untrusted caller cannot establish no-effect.

## Administrative abandonment is different

Normal `CLOSED` retains PH-0002's all-messages-finished precondition. It is not
broadened or repurposed. To avoid trapping an owner in endless reconciliation,
a separate immutable **ExchangeDisposition** records **ABANDONED_UNRESOLVED**.
The aggregate is administratively inactive while its Exchange snapshot stays
OPEN and its unresolved Messages stay DELIVERY_UNKNOWN.

The pure `archiveUnresolvedExchange` contract preserves:

- original DELIVERY_UNKNOWN state and transport `ambiguous`;
- full original started/ambiguous active-attempt snapshot and its endpoint,
  consumer, instance and fencing information;
- permanent `unresolvedSideEffects: true`;
- authenticated host-supplied owner principal ID, time, reason and
  reconciliation/investigation metadata.

It accepts an aggregate with at least one quarantined Message and otherwise
only finished Messages, not remaining in-flight activity. There must be
exactly one correctly correlated active attempt per unresolved Message.
Foreign/missing/duplicate/contradictory records, invalid timestamps and
immutable-record replacement are rejected; exact replay is allowed.

Administrative intent neither cancels external execution nor stops its side
effects. It stops further **protocol** activity without creating a Result,
changing delivery facts, or claiming success/failed-no-effect/cancellation.
There is no new execution outcome or identity format. Future API/events/UI
must expose the disposition alongside the unresolved facts, never summarize
it as cancelled or resolved. The disposition is itself the immutable
administrative audit record; reason/investigation text is sensitive stored
metadata, not a raw diagnostic log field. Runtime Result reads remain
repeatable, non-mutating historical observations.

`assertExchangeActive` is the admission check for the future host's creation,
claim and mutation paths. Existing transition/publication/close helpers reject
a supplied authoritative disposition. The host must authenticate the real
principal and load disposition, current state, full Message set and active
attempts itself inside the transaction. Labels, supplied owner text or
adapter omission of the guard are not security. Atomicity, persistence and
actual control/API enforcement remain deliberately unimplemented.

## Validation and scope

GREEN: **131/131 tests, 13 files**, including the retained quarantine
regression, all cancellation/close tests, disposition tests, unchanged 11
identity tests and mandatory built stdio/in-memory ping smoke. Typecheck,
build, ten negative architecture fixtures, workspace and whitespace checks
pass. Wayforge: **438/438 tests, 51 files**, background task
`<validation-task>`, exit 0. No Wayforge source changes.

No SQLite/store/broker/network/daemon, Pi or ChatGPT delivery, full MCP
operations, production installation or new dependency. `exchange_archive`
is only an optional authority declaration, separate from normal close; no
MCP operation was registered. Identity/outcome formats and ping behavior are
unchanged. The correction is committed independently, never amending
PH-0001/PH-0002 and never pushed. Its actual SHA and Wayforge evidence are
recorded in the final PH-0003 report.
