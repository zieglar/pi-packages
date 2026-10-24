# CE Productization 02 — Local validation evidence

## Scope

Original base: `1578a7bb6d672819ff9b3fe1479d26f008cb5e60`.
Approved design/plan: `docs/plans/2026-10-24-ce-productization02.md`.
Runtime/test commit: `8acc89eacdd9b705da702668361ae641c7a48968`.

This evidence concerns isolated implementation of current-session deactivation, read-only installation diagnostics, admitted identity status and user documentation. It is not a release or real-client acceptance record. No push, PR, merge, live Tunnel restart/reconfiguration, real message read/send/ACK or live Store cleanup was performed.

## Parent execution

Environment: macOS arm64, Node 24.21.0, pnpm 12.9.1. Separate worktree and offline frozen-lockfile dependency installation; installed source in the original checkout was not rebuilt or edited. Parent validation removed inherited `CE_*` environment entries. New command harnesses use temporary synthetic configuration/Store and injected process seams.

Executed from package directory:

| Command | Result | Local log |
|---|---|---|
| `pnpm run check` | PASS, architecture gate and negative fixtures | `/tmp/ceprod02-parent-check.log` |
| `pnpm run typecheck` | PASS | `/tmp/ceprod02-parent-typecheck.log` |
| `pnpm run build` | PASS | `/tmp/ceprod02-parent-build.log` |
| `pnpm exec vitest run test/endpoints/pi/extension-messaging-activation.test.ts test/endpoints/pi/extension-multi-session.test.ts test/endpoints/pi/extension-lifecycle.test.ts test/runtime/executables.test.ts test/runtime/diagnostics.test.ts test/runtime/installation-diagnostic.test.ts test/tunnel/extension-doctor.test.ts test/tunnel/extension-runtime-diagnostic.test.ts --maxWorkers=1` | 8 files / 137 tests PASS | `/tmp/ceprod02-parent-targeted.log` |
| `CE_PLUGIN_PACKAGE_TEST=1 pnpm exec vitest run test/plugin/local-plugin-package.test.ts --maxWorkers=1` | 1 file / 7 tests PASS, including artifact build and synthetic stdio/tool discovery | `/tmp/ceprod02-parent-plugin.log` |

Seven user-facing Markdown files: 47 relative links/anchors checked; 11 shell blocks parsed with `bash -n`, not executed. No private developer-machine path, Handoff ID or mandatory-looking `mise exec` in those seven files. Official OpenAI Tunnel, custom-MCP and plugin-packaging documentation was consulted for current UI/CLI instructions; external UI availability remains subject to client/workspace qualification.

Active LSP probe covered the three production TypeScript files. No TypeScript error was reported, but two results were inconclusive because the server is push-only/silent-on-clean; do not claim clean LSP coverage. Auxiliary AST findings include pre-existing style warnings and the new guarded non-null assertion at confirmation; compiler typecheck is the confirmed type evidence.

## TDD evidence reported by implementer

Initial RED: deactivation 7 failures; multi-session/status 3 failures; diagnostic helpers 11 failures; doctor command 3 failures. Corrected isolated command-dispatch-disable check: 12 failed / 51 passed, log `/tmp/ceprod02-api-isolated-command-red.log`. Corrected final child run: 137 tests / 8 files PASS, logs `/tmp/ceprod02-api-final-{build,green,typecheck,check}.log`. Parent independently reran the final 137 tests above.

## Isolation incident and correction

Earlier baseline/activation runs used an existing harness that injected process seams only into the fixture manager, not the separate extension-created manager. Those runs may have invoked read-only host process listing. No host mutation was observed or reported, but the earlier runs are not zero-probing isolation evidence.

The corrected activation and multi-session harnesses inject synthetic list/inspect seams into all managers and assert no default inspection, spawn or signalling calls. The doctor harness asserts no Manager/Store creation or append. Final parent command tests ran with these corrections; prior affected isolation claims are superseded, not erased.

## Explicit limits

- Full suite NOT RUN: existing real-client compatibility tests execute an installed client; broader unreviewed process harnesses are not assumed safe under the protected-live-runtime constraints.
- No real-client doctor/network checks, real Tunnel/ChatGPT acceptance rerun, production B/C lifecycle operation, manual interactive TUI validation or machine cold-start test.
- No new Node, SQLite, OS or client-version certification; host/child independently qualify through existing gates.
- Doctor diagnoses candidate installation eligibility, not the saved profile command, running child identity, compatibility, network readiness or message completion.
- Fixed-version four-lane review and parent synthesis are separate from these test results; passing tests alone do not approve the delta.
