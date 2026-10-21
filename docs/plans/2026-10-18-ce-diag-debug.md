# CE DIAG-01 Minimal Debug Logging Implementation Plan

> Execution: apply test-driven-development task by task in the authorized existing worktree. No commit until verification and review pass (handoff overrides early design commits).

**Goal:** Always-on development diagnostics for launcher, version guard, MCP frames, tools, Store/Authority and process lifecycle, with no protocol/authority changes.

**Architecture (approved):** A small synchronous JSONL logger writes private per-PID files under the module-derived `.debug-logs` directory (in the debug artifact's isolated `server/` directory), with best-effort stderr mirror and no stdout writes. No environment switches or dependencies. Log explicit allowlisted metadata, argument shapes and sanitized stack locations only. Wrap only the existing stdio transport's send/receive callbacks; preserve extras, return values, errors and callback wiring. Existing composition-root stages emit summaries; do not instrument or modify Authority/Core internals.

**Tech Stack:** Node 24.21.0, TypeScript, existing MCP SDK 1.30.1, Vitest.

## Task 1: Logger and frame observations
- Create `packages/pi-chat-exchange/test/control/debug-log.test.ts`; assert JSONL fields, sensitive-value omission, write-failure nonthrowing behavior, argument-shape privacy, and callback/response semantics.
- Run that test RED before implementing `src/control/debug-log.ts` and `src/control/mcp/debug-transport.ts`. Logger is Control-layer I/O; pure Core must stay filesystem-free.
- Implement minimal file logging, safe metadata helpers, delegating transport instrumentation; rerun GREEN.

## Task 2: Existing entrypoints and tool dispatch
- Create `test/control/mcp/debug-observation.test.ts` (real SDK in-memory protocol); RED: initialize, tools/list, ping call and invalid-call events absent.
- Modify only `src/control/mcp/server.ts`, `src/bin/mcp-stdio.ts` and (if needed for finer dispatch stages) `src/control/mcp/messaging-tools.ts` for observational events.
- Preserve tool schemas/advertisement, handler behavior, return values, lease shutdown semantics. Use uncaughtExceptionMonitor, not a swallowing handler; do not add unhandledRejection handlers that change Node's default exit.
- Rerun targeted regression tests, typecheck/build/check-contract on pinned Node.

## Task 3: Independent Debug artifact
- Add a dedicated debug packaging script, launcher/guard templates and focused subprocess tests. Never change the original gate-b1 0.1.5 source/cache.
- Build `pi-chat-exchange-gate-b1-debug` under the new DIAG artifact root using current dist and isolated dependencies. Contained `./bin/launch`, in-process STRICT_PIN v24.21.0, no auto-install; fixed isolated log directory. Preserve original production packaging behavior.
- Tests: launcher events, guard success/mismatch, initialize/initialized/tools/list/tools/call (isolated fixture only), invalid args, exit/signal, uncaught/rejection default exit, log-write failure and stdout JSON-RPC integrity. Use a fresh isolated Store fixture, never production or the existing gate-b1 Store.

## Task 4: Desktop and review
- Recheck frozen 0.1.5 inventory before/after. Register independent debug marketplace/cache only in isolated CODEX_HOME; preserve/record registration edits. No restart, chat message or agent task.
- Observe discovery/startup read-only for bounded 180s; if sending is needed, STOP runtime testing and report incomplete.
- Freeze diff/evidence; targeted privacy/protocol/authority/reproducibility review. Keep original review verdicts; additive corrections only for frozen evidence.
- Run final validations, inspect final diff, then one local commit if all correctness findings are resolved. No push/PR/merge/release. Write external `HANDOFF-CE-DIAG-01/RESULT.md`, status RESULT, await acceptance.
