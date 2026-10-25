# Independent Pi Tarball Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver an independently installable private CE Pi extension tarball, not a Desktop MCP ZIP or development-tree reference.
**Architecture:** User approved author-side build + validation + explicit native pack and files whitelist. Consumer does not build or execute lifecycle hooks; no frozen runtime/authority changes. Keep workspace author build; consumer receives runtime closure and does not need parent tsconfig.
**Tech Stack:** Node24.21.0, pnpm12.9.1, TypeScript5.9.3, npm native pack/install, Pi1.3.0.

## Approved design / constraints

Start affc05d024d0bef4254eaf14de7d521815c720ea. Use only fix/ce-distribution-fix worktree. No main modifications or merge/push/PR/tag/release. Private local artifact distribution only. No real Tunnel/client/credentials/Store/Session/business/ACK. All actual Host operations use synthetic private fixtures. No unrelated dependency upgrades or build-system refactor. Preserve first failures.

## Task 1: Characterization and minimal package repair

Files: packages/pi-chat-exchange/package.json; new scripts/package-pi-extension.mjs (or equivalently scoped name); new test/package/distribution.test.ts; docs/audits evidence as appropriate.
1. Read baseline installation report /private/tmp/ce-install-amendment/execution/report.md and current manifest/ignore/extension imports/native paths/build scripts. Inspect Pi host peer/runtime module usage before any dependency declaration change.
2. Write actual-native-pack regression asserting Pi entry/local TS modules, compiled transitive runtime paths including dist/bin/mcp-stdio.js, native/tunnel-keychain.swift and documented operator scripts. Assert secrets/store/build fixtures/node_modules/devtests absent. Preserve genuine RED against original manifest (build then pack still misses dist).
3. Minimal files whitelist, explicit author build-and-pack command, static/native payload validation and predictable output. No consumer pre/postinstall or prepare build. Avoid shipping broken consumer build config; explain author workspace requirement. Never blindly traverse symlinked source/private state or run shell-injected strings.
4. Test missing/incomplete dist detection, real pack inclusion and failure behavior. No weak test based solely on strings or mocks of native pack.
5. Re-run targeted tests to GREEN. Build/check/typecheck. Commit scoped implementation only after evidence recorded.

## Task 2: Independent package/Host regression and docs

Files: narrowly scoped new package/host distribution regression tests and support; package.json test lane only if needed; README.md, docs/tunnel-setup.md, pi-extension/README.md, independent-install guide.
1. Add opt-in heavy real tarball install + real Pi1.3.0 host regression, explicit prerequisites/fail-loud when enabled (no new silent skips). No source-tree -e fallback. Keep default test suite offline safe; test opt-in behavior cheaply where applicable.
2. Install unmodified artifact physically in fresh consumer with private cache/HOME/PI/XDG/TMP, approved Node. Native dependency bins may link internally; no external symlinks/hardlinks/workspace source references. Separate independently installed Host; deny developer tree runtime reads where feasible and network runtime. Audit lifecycle scripts before enabling any; prefer ignore-scripts and none required by consumer.
3. Actual PTY loads via formal pi install/list. Exercise doctor/configuration/profile, native synthetic Session registration and deactivate; no transport start/realclient/realStore. Doctor client-unavailable is diagnostic evidence, NOT real client compatibility success. If a prerequisite blocks genuine first-run, report BLOCKED rather than simulate PASS. Track owned children with safe cleanup, bounded waits; retain artifacts on failure. Reuse prior harness evidence, not arbitrary live PIDs/processes.
4. Documentation separates artifact producer (workspace frozen install/build/package) and consumer (trusted Node/Pi + native tarball dependency install + pi registration). Verify exact commands actually used; paths are user-local not developer mise requirements; keep Desktop separate. Specify version/hash and trust/permissions/prerequisites. Review host-provided peer warnings but don't break standalone compiled ESM resolution to silence warning.
5. Commit tests/docs and report full SHA, changed paths, commands, evidence directory and genuine RED/GREEN.

## Task 3: Fixed-artifact verification and review (parent coordinates)

1. Freeze clean commit; record baseline, complete diff and artifact hash.
2. Independent verifier runs build/check/typecheck, targeted tests, full relevant CE default selection with --no-file-parallelism, plugin tests, real pack, fresh physical tarball install, real Pi1.3.0 load and first-run smoke. Maintain approved isolated fixtures and existing safety exclusions; no existing-client tests or business operations.
3. Independent fixed-delta review of package closure, install scripts, dependencies, reproducibility, permissions/trust and exact docs. No moving commit while reviews/verifier read it. Repair confirmed findings sequentially, then refreeze/reverify affected scope.
4. Parent inspects diff and evidence. Result must separate SOURCE_BUILD, PACKAGE_INSTALL, REAL_HOST_LOAD, FIRST_RUN and CLOUD_TRANSPORT_NOT_VERIFIED. Recommend re-entry only if install/load/first-run all PASS; otherwise explicit REWORK and smallest next step. No integration/publication authority implied.
