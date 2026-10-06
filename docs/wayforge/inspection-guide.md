# Wayforge Operator Inspection Guide

How to audit governed Wayforge task history through the supported read-only
inspection surface. Grounded in `packages/wayforge/src/durable/inspection.ts`
(the sanitized projection), `packages/wayforge/src/runtime/extension-tools.ts`
(the tool surface), `packages/wayforge/src/durable/state.ts` (durable state),
`packages/wayforge/DESIGN.md`, and `packages/wayforge/CONTRIBUTING.md`.

## Purpose

This guide covers auditing governed Wayforge history — what ran, how it
settled, and what to do next — using the two supported read-only inspection
tools and nothing else.

It explicitly does not cover:

- reading raw durable files, diagnostic logs, or transcripts (never required,
  and raw store contents are not an operator surface);
- mutation or recovery actions (inspection is structurally read-only; it
  lists and reads through the durable store, never mutates task state);
- runtime diagnostics or event streams, which are not substitutes for
  authoritative task state.

## Tools

Two tools, both returning sanitized JSON and never raw provider data:

- `wayforge_tasks` — takes no parameters. Lists all historical durable
  tasks as compact summary rows, newest activity first. Use it to find a
  task and scan overall state.
- `wayforge_task_status` — takes one optional parameter, `taskId` (string).
  - Without `taskId`: shows the sanitized live snapshot of the workflow
    running in the current session (requires an active workflow; otherwise
    the tool refuses with `workflow_not_started`).
  - With `taskId`: shows the sanitized detail of one historical durable
    task — no live workflow required, because historical inspection is its
    whole purpose. Example: `wayforge_task_status { "taskId": "<task id>" }`.

Both historical surfaces refuse closed when inspection cannot be served:
`ownership_guard_blocked` when the ownership guard failed closed in the
session, and `governed_execution_unavailable` when durable task authority
could not be initialized. A store-side read or corruption failure surfaces
as the typed failure `durable_inspection_unavailable`; an unknown `taskId`
surfaces as `task_not_found`. Raw store error messages are never propagated.

## Reading the listing

Each `wayforge_tasks` summary row contains exactly:

- `source` — always `"durable"`;
- `taskId` — the durable task identifier to pass to `wayforge_task_status`;
- `status` — one of `pending`, `running`, `suspended`, `resuming`,
  `blocked`, `completed`, `cancelled`;
- `objective` — an excerpt of the task objective, truncated to 200
  characters;
- `revision` — the durable revision counter;
- `createdAtMs` / `updatedAtMs` — creation and last-update timestamps;
- `nextAction` — the supported operator next action (see
  [Operator decision guide](#operator-decision-guide));
- `suspension` — present only for a suspended task (see below);
- `completion` — present only when completion evidence exists (see below).

Ordering guarantee: rows are sorted by descending `updatedAtMs`, then
descending `createdAtMs`, then ascending `taskId` — newest activity first,
with a deterministic tiebreak.

The listing stays compact deliberately: it is a triage view. Detail-only
fields (`completionCriteria`, `currentPhase`, `unresolvedCount`,
`lastFailure`, `negativeReview`) require reading one task by `taskId`.

## Reading one task

`wayforge_task_status { "taskId": "<task id>" }` returns everything in the
summary row plus:

- `completionCriteria` — the task's completion criteria, truncated to 200
  characters;
- `currentPhase` — the durable phase label;
- `unresolvedCount` — the number of unresolved work items;
- `lastFailure` — present only when a failure is recorded, and reduced to
  `kind` and `code` only; the full failure payload is deliberately omitted;
- `negativeReview` — present only for a settled negative review (see
  [Negative review history](#negative-review-history)).

The completion marker, when present, is:

- `completion.authoritative` — `true` only when the durable completion
  evidence carries Completion Authority provenance
  (`completion_authority_v1`); any other evidence shape renders
  `authoritative: false`;
- `completion.completedAtMs` — present only on an authoritative marker.

Successful acceptance of a task requires `status: "completed"` **and**
`completion.authoritative: true` — not merely an approving runtime message.

The suspension view, present only when `status` is `suspended`, contains
`reason`, `strategy`, `resumeNotBeforeMs`, and `nextCheckAtMs` — the bounded
resume window, without the originating failure record.

## Negative review history

When the authoritative completion review settled with a `changes_requested`
verdict, the task detail exposes one `negativeReview` field containing:

- `outcome` — always the literal `"changes_requested"` (approvals live in
  completion evidence; abstention, invalid output, provider failure, and
  cancellation are not negative judgment and are never recorded here);
- `recordedAtMs` — when the fact was recorded;
- `summary` — a bounded, sanitized summary (at most 1,000 characters,
  stripped of secret material, absolute paths, and control characters
  before persistence).

The durable record additionally binds the reviewed completion candidate by
digest, so later workspace drift does not erase the judgment; that digest
is deliberately not exposed (digest internals stay out of the projection).
The fact is written at most once by the Completion Authority inside the
completion path, under lease and revision fencing.

Interpretation rules:

- It is **non-authorizing historical evidence**: by itself it never
  authorizes, blocks, or spends anything.
- **Absence is unknown** — the record may be a legacy (pre-generation-3)
  record or the review may simply never have settled. Absence is never
  proof that no review happened.
- It **never means a review allowance is exhausted**; it carries no
  review-allowance semantics.

## Completion vs negative review

Completion evidence and a settled negative review are two mutually exclusive
kinds of durable evidence: the durable state codec rejects any record
containing both. A task that completed authoritatively shows
`completion.authoritative: true` and never a `negativeReview`. A task whose
completion review settled as `changes_requested` shows `negativeReview` and
never authoritative completion. A negative review never completes a task;
it records that one reviewed candidate was rejected.

## Liveness and privacy

A `running` durable record is **not proof of liveness**. The projection
never presents it as such, and the `nextAction` for `running` says so
verbatim (see the next section). An interrupted `running` task may be
reconciled to `blocked` on startup; inspection reports durable state, not
process liveness.

As a privacy guarantee, the projection structurally omits, by design:

- workspace paths and roots (the durable schema may hold them internally;
  that is not permission to expose them);
- account identifiers (including the optional sanitized `accountKey`
  provenance);
- digest internals (candidate, workspace, and verdict digests);
- raw failure payloads and originating failure records (only `kind`/`code`
  survive), and provider request/response payloads.

## Operator decision guide

The `nextAction` field is the supported operator guidance. Its wording is
derived from durable status alone (one historical override, noted last):

| Status | `nextAction` (verbatim) | Meaning |
| --- | --- | --- |
| `completed` | `no action required` | Task completed; acceptance additionally needs `completion.authoritative: true`. |
| `cancelled` | `start a new task if desired` | Terminal; nothing resumes it. |
| `blocked` | `inspect the failure and start a new task after correction` | Read `lastFailure` (`kind`/`code`), correct the cause, and admit a new governed task. |
| `suspended` | `waiting for the existing resume condition` | Wait for the resume window in `suspension`; do not restart manually. |
| `resuming` | `resume is in progress; no operator action is required yet` | Recovery is underway. |
| `pending` | `task has not started execution yet` | Nothing to audit yet. |
| `running` | `durable state is running; liveness is not established by this inspection` | Do not infer a live process; see [Liveness and privacy](#liveness-and-privacy). |

Historical override: when a task detail carries a settled `negativeReview`
and the task is not `completed`, `nextAction` is instead
`correct the work and start a new governed task`. The one-shot completion
review is terminal for that task: apply corrections with explicit ownership
and admit the corrected workspace through a **new governed task/candidate
lifecycle**. Never manually edit durable state to recover or complete a
workflow, and never treat `completion_review_spent` as an escape hatch.

## Open questions

- For a legacy (generation-2) durable record, absence of `negativeReview`
  cannot distinguish "no review settled" from "record predates the field";
  the sources settle only that absence is unknown.
- Review outcomes other than `changes_requested` (abstention, invalid
  output, provider failure) leave no durable historical trace in the
  projection; whether they ever will is not settled by the sources.
- Durable review-allowance enforcement across restarts is explicitly out of
  scope today, so inspection cannot answer allowance questions.
