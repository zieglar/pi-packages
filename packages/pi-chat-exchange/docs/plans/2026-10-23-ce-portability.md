[English](./2026-10-23-ce-portability.md) | [简体中文](./2026-10-23-ce-portability.zh-CN.md)

> Historical plan (2026-10-23). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# CE Runtime Portability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the already-qualified Node 24.21.0 installation usable without mise or developer-machine paths, while preserving all CE authority and runtime contracts.

**Architecture:** Add one bounded executable-admission and Node-qualification boundary, reused by production setup and local Desktop configuration. Select explicit operator paths first, then the qualified current executable, then a fixed set of system locations; never search project PATH or execute a candidate before filesystem trust admission. Keep portable Desktop artifacts unconfigured until an explicit per-machine operation generates an absolute, qualified Node command.

**Tech Stack:** TypeScript, Node child_process/fs, existing storage runtime assertions, Vitest, local ESM packaging scripts.

## Authorization and frozen contracts

- Baseline: main at ae6efc87935ab8060fccd7ce43d05649a6daafd6. Parent is the only writer. Preserve unrelated untracked files.
- Do not change storage/runtime.ts, approved Node/SQLite/source/platform identity, Store/Session/Ownership/protocol/schema/capability/ACK contracts, or multi-session architecture.
- Do not run a real Tunnel/client, read credentials or user Stores, register Marketplace software, mutate global Pi configuration, send messages, push, or release.
- No intermediate commits. Commit the exact reviewed file set locally only after the four review lanes and parent synthesis close blockers.
- Two existing read-only scouts may refine file/API details; their results are evidence, not authority to expand this scope.

## Design and refusal behavior

1. Explicit executable configuration must be absolute and canonicalizable. Validate the original path, symlink resolution, executable regular-file metadata, ownership and writable ancestors before any subprocess probe. Reject project-local executables and relative/empty/PATH-based candidates. Follow only validated symlinks to a trusted canonical target. Do not accept group/world-writable executables or mutable traversal components. Temporary tests use private directories beneath an OS-owned sticky temporary ancestor.
2. Node selection: explicit CE Node configuration (invalid means refusal, not silent fallback), qualified current Pi executable, controlled system candidates, then validated legacy mise location for compatibility. System discovery is a fixed allowlist, independent of inherited PATH; optional Homebrew locations are candidates, never mandatory defaults. Candidate execution uses argv, no shell, a minimal environment without NODE_OPTIONS or loader injection, bounded timeout/output, and an in-memory SQLite identity probe checked by the unchanged storage qualification assertion. The running Pi host remains independently subject to the existing Store runtime guard; selecting another child does not upgrade the host.
3. Client selection: explicit trusted absolute client configuration or controlled system candidates. No version/health/network probe during discovery. Preserve the selected absolute invocation spelling when needed by existing exact process-identity rules; do not relax wrapper evidence, UNKNOWN, cross-process locking or stop-fail-closed behavior. Missing client permits inspection/repair but refuses spawn before any real process action.
4. Desktop distribution: no developer path and no unqualified `node` command. A portable artifact has no runnable stdio server until a local configuration operation validates the selected Node and writes the standard MCP server entry. Generated manifests belong only to the operator's local copy, not to transferable ZIP/Marketplace output. Configuration does not install/register/start anything or access a binding/Store. Secure Tunnel use requires no Desktop Marketplace plugin.
5. Diagnostics expose stable refusal reasons, sanitized current Node/version and repair instructions, not raw child stderr, credentials, arbitrary environment data or private binding contents.

## Task 1: Executable trust and Node qualification (TDD)

**Files:** Create `src/runtime/executables.ts` and `test/runtime/executables.test.ts`; read-only `src/storage/runtime.ts`.

1. Add failing tests for explicit approved selection, invalid explicit refusal, current approved executable, controlled discovery, no mise, ignored hostile project PATH, spaces, symlink targets, permissions, missing executable and unapproved identity.
2. Run the new Vitest file under approved Node and confirm failures are behavioral/missing-export failures.
3. Implement metadata admission separately from execution; injectable filesystem/probe seams are unit-test dependencies, never environment qualification overrides.
4. Probe only admitted candidates; parse bounded identity JSON and call the existing qualification assertion. Never equate version-only equality with full qualification.
5. Run tests, plus unchanged `test/storage/runtime.test.ts`.

## Task 2: Production setup and diagnostics (TDD)

**Files:** Modify `src/tunnel/setup.ts`, `src/tunnel/profile.ts`, and relevant setup/profile tests; modify `pi-extension/index.ts` only where diagnostics/configuration integration requires it.

1. Add regression tests showing production selection works with an approved absolute Node outside mise, rejects unapproved or untrusted candidates, and does not write a runnable profile after refusal.
2. Preserve existing pure profile grammar and legacy command migration. Explicit constructor dependency seams in existing tests must not become production environment bypasses.
3. Integrate the admitted resolver at production selection sites. Keep host Store guard distinct from child selection and provide an actionable host-runtime repair message.
4. Run profile/setup/extension test suites. Check that channel tokens, credential references, binding references and manager barriers remain unchanged.

## Task 3: Portable client selection (TDD)

**Files:** Modify `src/tunnel/background-manager.ts`; extend `test/tunnel/background-manager.test.ts` or a focused portability test.

1. Add failing tests for a trusted non-Homebrew explicit client, controlled discovery, missing client refusal without spawn, and hostile PATH not executed.
2. Integrate discovery without changing identity comparison, wrapper parsing, manager record format, locks or stop behavior.
3. Run background manager, stop/concurrency and setup barrier tests; assert legacy injected-client fixtures still exercise the original authority logic.

## Task 4: Per-machine Desktop manifest (TDD)

**Files:** Modify `plugin/pi-chat-exchange/mcp.json`, `scripts/package-local-plugin.mjs`, `test/plugin/local-plugin-package.test.ts`, `package.json`; create a bounded local configuration script and focused tests.

1. Replace tests pinning the developer path with tests requiring an unconfigured distribution, no `/Users/` machine paths and no unverified `command: node`.
2. Add tests that local manifest generation accepts an approved trusted absolute path (including spaces), refuses unsafe/unapproved paths, does not alter distribution templates, and does not access Store/config credentials or register software.
3. Implement explicit local configuration using the shared admission/qualification code; write a standard absolute-command manifest only into the chosen local copy, refusing unsafe file targets.
4. Package tests configure only temporary/local test copies, then launch the manifest's actual command under `/usr/bin:/bin` with no mise variables. Use temporary bindings/Stores and ping/tool discovery only; no CE messages.

## Task 5: Documentation and validation

**Files:** Bounded updates to package README, `docs/tunnel-setup.md` and plugin README.

1. Document host versus MCP child qualification, explicit path settings, controlled discovery, installation without mise, client repair and separate Desktop stdio versus Secure Tunnel routes.
2. Run targeted tests after each task. Under approved Node, from `packages/pi-chat-exchange`, use the scoped sequence below; **do not run unrestricted `pnpm verify` or `pnpm test` for this handoff**, because the installed-client compatibility suite may execute the real client. Keep its three tests explicitly excluded. Use bounded concurrency to avoid the observed default-worker 5-second timeout; do not relax production or test timeouts.

   ```sh
   pnpm run check
   pnpm run typecheck
   pnpm run build
   pnpm exec vitest run --exclude test/tunnel/real-client-compat.test.ts --maxWorkers 2
   pnpm run test:plugin-package
   pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023 --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck pi-extension/index.ts
   ```

3. Record command, actual Node identity, exit status and complete logs in a new temporary evidence directory. Do not claim skipped privilege tests or an actual Desktop UI installation were verified.
4. Reproduce no-mise execution with an actual approved Node copy outside mise, no MISE variables and controlled PATH; verify real MCP ping and unchanged Store create/reopen in temporary roots.

## Task 6: Fixed four-lane review and local commit

1. Freeze the exact uncommitted delta: base SHA, file manifest, patch and SHA-256 fingerprint, validation evidence.
2. Run independent lanes: A diff/privacy/docs; B authority/frozen contracts; C validation/coverage; D standards/maintainability. Record actual model provenance; do not claim cross-family independence if routing used the same family.
3. Remediate blockers, rerun relevant validation and re-freeze/review changed targets. Parent synthesis must close all blocking findings against one unchanged final fingerprint.
4. Stage only the reviewed manifest and create one authorized local commit. No push/PR/release.
5. Report HANDOFF-CE-PORTABILITY-01 RESULT with verdict, files, commit, test evidence, all four lane outcomes, no-mise evidence, untested risks and next step. Wait for ChatGPT acceptance; do not begin Node 24.22 work.
