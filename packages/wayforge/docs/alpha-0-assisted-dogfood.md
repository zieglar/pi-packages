# Wayforge Alpha 0 — Assisted Dogfood Guide

**Status:** Phase 1B.1 runtime workflow. This document describes how to run one
assisted, fully isolated Wayforge workflow against this repository, and what
evidence to keep. It is deliberately small: Alpha 0 is an assisted dogfood, not
an autonomous agent.

## What Alpha 0 is

- Native Pi Main stays native. Wayforge is an extension, not a host.
- `/wayforge <objective>` starts **one** in-process managed task.
- Main may delegate **1–4 bounded Workers** per call through the public
  `pi-subagents/delegation` event contract.
- Main may request **Advisor review** through the real Pi `ModelRuntime`
  (`NestedInvoker` → `ModelRegistry.streamSimple` → composed provider).
- Completion is gated: at least one passing validation, no failing latest
  validation, and (in this workflow) an approving `beforeDone` advisor verdict.
- Every failure returns to Main with an explicit, bounded recovery plan. There
  are no hidden retry loops; cancellation is always terminal.
- The session ownership guard fails closed if `pi-multi-account`,
  `pi-shift-router`, or `pi-advisor-flow` owns capabilities in the session.

## Explicit limitations (do not claim otherwise)

1. **In-process only.** Workflow state lives in memory. If Pi exits, the task
   is gone; there is no restart or resume. This is stated, not missing.
2. **No ambient account plugin.** Alpha 0 does not adapt the active
   `pi-multi-account` plugin; competing sources fail closed instead.
3. **No autonomous continuation.** Recovery executes only what the operator or
   Main explicitly requests, within the deterministic budget.
4. **Observed-model routing.** Worker/Advisor routes are role-scoped views of
   the model Main already uses; Wayforge does not rewrite the parent model to
   take ownership.
5. **Evidence is curated.** The evidence file below is a redacted projection
   produced with manual inspection; it is not a full transcript.

## One-time setup

```bash
npm ci                 # pinned deps: pi-coding-agent 1.0.2, pi-subagents 0.70.0
npm run verify:alpha0  # 9 architecture gates, full tests, typecheck, build, alpha0 gate
scripts/pi1-dev.sh --setup
```

`--setup` writes two shims under `.wayforge-dev/agent/extensions/`:

- `wayforge.js` → re-exports `dist/extension.js`,
- `pi-subagents.js` → re-exports the project-pinned `pi-subagents`.
  (`.js`, not `.mjs`: Pi 1.x only discovers extension files ending in `.ts`/`.js`.)

Nothing outside `.wayforge-dev/` is written; production `~/.pi` is never read.

## Isolated login (operator step)

The isolated profile starts with **no models**. Run:

```bash
scripts/pi1-dev.sh --list-models
```

If it reports none, start the TUI once (`scripts/pi1-dev.sh`) and run `/login`
**inside that isolated session**, or use the login flow it offers. Credentials
land only under `.wayforge-dev/` (git-ignored). Never copy credentials from
production `~/.pi`.

Verify afterwards:

```bash
scripts/pi1-dev.sh --list-models   # must list at least one authenticated route
```

## Running one workflow

```bash
scripts/pi1-dev.sh
```

Then in the session:

1. `/wayforge <small, reversible repository objective>`
2. Main works directly and/or calls `wayforge_delegate_workers`.
3. Main records every validation with `wayforge_record_validation`
   (e.g. `npm test`, `npm run typecheck`).
4. Before finishing, Main calls `wayforge_advise` with `beforeDone: true`.
5. Main calls `wayforge_complete`; on success the task is `completed`.
   `wayforge_cancel` aborts at any point; `wayforge_task_status` shows the
   sanitized snapshot at any time.

## Evidence

During every run the extension itself persists two redacted artifacts under
`<PI_CODING_AGENT_DIR>/wayforge/` (i.e. `.wayforge-dev/agent/wayforge/` in the
isolated profile) — no manual copying from the TUI is needed:

- `<taskId>.events.jsonl` — the full redacted event stream, one JSON per line;
- `<taskId>.status.json` — the latest sanitized status snapshot.

The disk sink is write-only observability: the in-memory log stays authoritative,
nothing is read back, and disk failures never break a running workflow.

After the run, save a redacted projection to
`docs/evidence/phase-1b1-alpha0-dogfood.json` with this shape (all values must
be safe to publish; no credentials, no transcripts, no hidden reasoning):

```json
{
  "phase": "1B.1",
  "taskId": "alpha0-<n>",
  "objective": "<the objective text>",
  "completionCriteria": "all recorded validations pass and the before-done advisor approves",
  "main": { "invocationId": "...", "observedRoute": "provider/model" },
  "workers": [{ "invocationId": "...", "route": "provider/model", "status": "completed" }],
  "advisor": { "invocationId": "...", "verdict": "approve", "route": "provider/model" },
  "validations": [{ "name": "npm test", "ok": true, "summary": "N passed" }],
  "recoveryBudget": { "retriesLeft": 1, "fallbacksLeft": 2 },
  "events": "<kind, kind, ... redacted sequence>",
  "changedPaths": ["README.md"],
  "verification": {
    "automated": ["check:architecture", "npm test", "typecheck", "build", "check:alpha0"],
    "manuallyInspected": ["<what a human actually verified>"],
    "inferred": ["<claims inferred, not directly observed>"]
  }
}
```

`npm run check:alpha0` validates that tracked evidence parses as JSON.

## Troubleshooting

- **“ownership guard failed closed”** — a competing extension owns a reserved
  capability. Disable it for this session or remove Wayforge; Wayforge never
  uninstalls anything itself.
- **“No models available”** — the isolated profile has no credentials; redo the
  isolated `/login` step. Do not copy production credentials.
- **`worker_model_mismatch`** — the Worker terminal evidence did not match the
  selected route; the outcome fails closed. Retry with an explicit delegation.
- **`completion_gate_failed`** — a latest validation is failing or no approving
  advisor verdict exists yet.
- **`recovery_blocked` / `recovery_suspended`** — the deterministic recovery
  budget is exhausted or a reset-bearing limit suspended the task; these are
  terminal for the task by design.
