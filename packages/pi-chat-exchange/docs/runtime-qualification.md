[English](runtime-qualification.md) | [简体中文](runtime-qualification.zh-CN.md)

# Runtime decoupling: current development policy

Handoff: `HANDOFF-PI-SQLITE-RUNTIME-DECOUPLE-01`. The sections below for COMPAT-02 and the original exact-runtime qualification are historical. Published npm 0.2.0 is unchanged.

> Follow-up (2026-10-29): the current source declaration is `>=24.20.0 <=24.22.2` after actual macOS arm64 Node 24.22.2 qualification. The original matrix and its then-current `24.22.1` cap below remain historical evidence; current results and Node 25 refusal reasons are in [runtime support](runtime-support.md). Published npm 0.2.0 and its exact engines are unchanged.

The current candidate policy removes exact SQLite 3.53.4 and source-ID equality as admission requirements. Runtime identities remain observable evidence; they are not substitutes for behavior checks. Node candidates are bounded to canonical stable 24 (>=24.12.0), 25 and 26, subject to all remaining safety gates and actual qualification. Future majors are not automatically supported.

A necessary SQLite safety floor remains: **3.51.3 or newer**. SQLite's [WAL-reset bug](https://sqlite.org/wal.html#walresetbug) can corrupt WAL databases when multiple connections in separate processes/threads write or checkpoint concurrently. CE uses WAL and multiple processes, so affected SQLite 3.50.4 in actual Node 24.12.0 and 25.2.1 is refused even though the memory/API probes pass. Older fixed backports are conservatively outside this policy. The issue is upstream-confirmed; this work does not claim local corruption reproduction.

A separate **locally reproduced native crash** blocks Node 24.19.0 (SQLite 3.53.3) and 25.9.0 (SQLite 3.51.3). The existing `transaction-security.test.ts` case `unreadable transaction state cannot escape outcome classification` closes a privileged connection inside an owned transaction. An independent process using the production transaction helper exits with SIGSEGV on these two binaries; 24.20.0, 24.21.0 and 26.12.1 instead return the required `STORAGE_TRANSACTION_FAILED / INDETERMINATE`. This is a process-crash finding, not evidence of disk corruption. Exact exclusions preserve that measured safety boundary; passing the SQLite floor and ordinary probes cannot override them.

Platform and compile-safety requirements remain unchanged. Cheap shared Host/child memory probes must establish the required SQL/API behavior; file locks, WAL/FULL policies, schema v7, trust root, commit uncertainty and crash reconciliation require separate bounded real-runtime tests. Passing startup probes is not a full compatibility certificate.

The package declaration is deliberately bounded to **`>=24.20.0 <=24.22.1`**. The four listed/tested releases (24.20.0, 24.21.0, 24.22.0, 24.22.1) are real Darwin arm64 binaries; the official Node release inventory at investigation time lists no other released patch in this interval. This is not qualification of later patches. Node 26.12.1 is a separately tested preview, excluded from formal engines; Node 25 has no supported declaration. Future releases, Linux and power-loss durability remain unverified.

| Actual Node | SQLite | Disposition |
| --- | --- | --- |
| 24.12.0 | 3.50.4 | Refused: upstream WAL-reset defect |
| 24.19.0 | 3.53.3 | Refused: locally reproduced native transaction-close SIGSEGV |
| 24.20.0 / 24.21.0 / 24.22.0 / 24.22.1 | 3.53.4 | Bounded development support; targeted storage/runtime, protocol and real Pi 1.3.0 Host evidence |
| 25.0.0 | API negative control | Refused: missing defensive API |
| 25.2.1 | 3.50.4 | Refused: upstream WAL-reset defect |
| 25.9.0 | 3.51.3 | Refused: locally reproduced native transaction-close SIGSEGV |
| 26.12.1 | 3.54.0 | Preview: actual distinct SQLite engine, targeted/broader storage, protocol and real Host evidence; no LTS support claim |

The final five-runtime matrix (24.20.0, 24.21.0, 24.22.0, 24.22.1, 26.12.1) verifies all 25 directed pairs: clean reopen/content preservation, precommit lock contention/SIGKILL rollback and postcommit lost-response reconciliation (75 tests). Actual MCP protocol runs cover all 25 parent/child combinations plus composed independent Pi factory processes. Each runtime's targeted suite passes 337 tests with no skips. The broader Node 26 storage/runtime suite passes 1043 tests without skips. Earlier broad-run failures from deprecated test loader warnings were corrected using synchronous `registerHooks`; disk-fault/crash injection was scoped to file connections so the new memory COMMIT probe cannot consume intended fault boundaries. First failing runs are evidence, not compatibility passes.

Evidence: `<private-evidence-root>/sqlite-runtime-decouple-01/` contains acquisition/identity inventories, original refusal and RED evidence, per-runtime gates, known-WAL-defect evidence and fixed-target independent reviews. New official archives were compared to HTTPS SHASUMS; detached signatures were not verified.

## Historical COMPAT-02 policy

# Runtime capability admission: development candidate

Handoff: `HANDOFF-PI-NODE-SQLITE-COMPAT-02`. This section supersedes the historical exact-Node admission policy for the local development candidate only. Published npm 0.2.0 is unchanged.

The Node candidate gate is `>=24.21.0 <25`, excluding prereleases, custom suffixes and noncanonical versions. Passing it is necessary but insufficient: SQLite must remain exactly 3.53.4 with source ID `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`, supported platform/architecture and the existing required/forbidden compile-option checks. No SQLite identity expansion is authorized.

The package declaration is deliberately narrower: `>=24.21.0 <=24.22.1`. Actual tested binaries are 24.21.0, 24.22.0 and 24.22.1 on Darwin arm64. This is not certification of future Node 24 releases or Linux. A later candidate outside this declaration must pass qualification and receive separate regression evidence before extending the declaration.

Host and MCP child execute the same self-contained, compiled in-memory probe function. It proves defensive mode, statement get/all/run, transaction state, transaction and preprepared-savepoint authorizer denial, authorizer reset and rollback with no retained row. Failure refuses before persistent Store-path preparation; no environment version override or fallback weakens this gate. Child executable ownership/path/ACL admission is unchanged.

Current v7 schema validation, old-schema refusal, persistence, locking, SIGKILL and uncertain-outcome reconciliation remain separate disk-based regressions. No schema, ledger, recovery protocol or message format changed. Process-kill testing does not prove power-loss durability. Real Host testing uses Pi 1.3.0 and synthetic isolated configuration/Store; it does not execute a real Tunnel client.

Evidence is retained outside both repositories at `<private-evidence-root>/node-sqlite-compat-02/`: runtime acquisition/identity records, RED/GREEN logs, final targeted command envelopes, installed-Host evidence and fixed-target independent review. The new 24.22.0 official archive was checked against HTTPS SHASUMS; detached signatures were not verified.

The following report is historical evidence for `HANDOFF-CE-RUNTIME-QUALIFICATION-01`; its exact-whitelist language and previous counts do not describe this candidate.

# Exact runtime qualification evidence

Task: `HANDOFF-CE-RUNTIME-QUALIFICATION-01`. This record describes observed qualification evidence, not a broad Node 24 support claim. Final acceptance also requires the fixed-target four-lane review and operator acceptance.

## Real identities

| Field | Runtime A | Runtime B |
| --- | --- | --- |
| Node | v24.21.0 | v24.22.1 |
| Platform / architecture | darwin / arm64 | darwin / arm64 |
| SQLite | 3.53.4 | 3.53.4 |
| SQLite source ID | `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc` | same |
| Compile-option inventory | 50 options | identical 50 options |
| Required options | `THREADSAFE=1`, `MUTEX_PTHREADS` | same |
| Behavioral API probes | defensive mode, statement get/all/run, transaction state | same |

A is the existing local exact-version installation. B is the official `node-v24.22.1-darwin-arm64.tar.gz`, downloaded privately, SHA-256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7`, compared against the official HTTPS SHASUMS. Detached signatures were **not** verified. Complete inventories, absolute executable paths, acquisition provenance and executed command/exit envelopes are in the local evidence bundle `<runtime-qualification-evidence-bundle>` (`formal-identities.json`, `initial-identities.json`, `acquisition.json`). No global runtime configuration changed.

## Observed compatibility matrix

All stores, endpoints and messages were synthetic temporary fixtures. No real Tunnel/client or operator Store was used.

| Predicate | A | B |
| --- | --- | --- |
| Create, close, reopen, integrity / foreign-key checks | PASS | PASS |
| WAL / FULL / foreign-key / trusted-schema policies | PASS | PASS |
| Transactions, locking, concurrent writers, rollback and uncertain-result reconciliation | PASS | PASS |
| Process-kill recovery and fresh-handle replay | PASS | PASS |
| Store identity, schema, ledger and trust-root stability | PASS | PASS |
| Endpoint / Session / Ownership / capability refusal | PASS | PASS |
| Inbox / payload read / ACK authorization | PASS | PASS |
| Actual stdio initialization, tool discovery and ping | PASS | PASS |
| Generated portable manifest, no mise, minimal PATH, executable path containing spaces | PASS | PASS |
| Resolver path/ownership/ACL refusal and independent host/child qualification | PASS | PASS |
| Contract, project typecheck, build, strict extension compiler | PASS | PASS |
| Bounded full suite | 2561 pass, 5 skip | 2559 pass, 7 skip |
| Gated packaged-plugin suite | 7 pass | 7 pass |

`runtime-cross-version.test.ts` exercises all A→A, A→B, B→A, B→B pairs (12 tests): committed message/audit/idempotency identities, stable Store metadata/ledger/trust root, clean reopen, pre-commit lock contention and SIGKILL rollback, post-commit/pre-response SIGKILL and fresh-handle idempotent reconciliation. This suite passed in both full runs. These are process-crash tests, **not power-loss durability proof**.

The actual multi-session stdio test runs both A and B children under each parent, giving all four Host→MCP combinations. It covers bidirectional messaging, inbox, payload and ACK, wrong-endpoint refusals, current/loaded grant intersection, global opt-in removal, invalid-policy refusal and ownership/session cleanup. Packaged generated-manifest launches separately prove each selected portable executable.

Actual Node v25.2.1, including spoofed environment version values, refuses before Store-path creation. Unit tests cover unapproved patches/versions, SQLite source/version/platform mismatch, missing or malformed compile/API evidence and safety-disabling compile options. There is no production environment guard bypass.

## Reproduction and retained evidence

From the package directory, execute each command with the **absolute selected Node binary**, and prepend only its bin directory to the command-local PATH. `CE_TEST_NODE_A`, `CE_TEST_NODE_B` and `CE_TEST_UNAPPROVED_NODE` select actual binaries for tests only; they do not change production admission.

```sh
"$NODE" scripts/check-contract.mjs
"$NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
"$NODE" node_modules/typescript/bin/tsc -p tsconfig.build.json
CE_TEST_NODE_A="$A" CE_TEST_NODE_B="$B" CE_TEST_UNAPPROVED_NODE="$U" \
  "$NODE" node_modules/vitest/vitest.mjs run \
  --exclude test/tunnel/real-client-compat.test.ts --maxWorkers 2
CE_PLUGIN_PACKAGE_TEST=1 "$NODE" node_modules/vitest/vitest.mjs run \
  test/plugin/local-plugin-package.test.ts --maxWorkers 2
"$NODE" node_modules/typescript/bin/tsc --noEmit --target ES2023 \
  --module NodeNext --moduleResolution NodeNext --lib ES2023 --types node \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --verbatimModuleSyntax --skipLibCheck pi-extension/index.ts
```

All twelve final gate command exits were 0 on the final candidate bytes; logs and exact argument/environment envelopes are `formal3-{contract,typecheck,build,full,plugin,extension}-{24.21.0,24.22.1}.{log,json}` in the local bundle. Earlier `formal-*` envelopes record the pre-review pass on the same suites, and `formal2-*` preserves the edit incident listed below. Separate mixed Host/MCP logs are `formal-host-mcp-*.{log,json}`. The production probe inventories are `formal-identities.json`.
The review-target aggregate fingerprint is SHA-256 over the canonical sorted-key JSON of `review-r1/target.json` with its own `fingerprint` field removed (Python `json.dumps(..., sort_keys=True)` UTF-8 bytes).

First failures are retained, not replaced by the successful runs:

- Initial registry/admission RED: 24 failed / 10 passed; migration/recovery RED: 2 failed / 3 passed / 4 test-environment skips. Failures showed missing strict evidence checks, B rejection and premature path creation.
- Initial API fault fixtures: 2 failed / 68 passed under each runtime. The defective defensive-mode and transaction-state mocks were corrected to actually induce the intended abnormal behavior; SQLite's defensive default was not weakened.
- Resolver/diagnostic RED: 9 failed / 28 passed; missing probe evidence and single-version expectations were then updated.
- First A full run: 2546 passed / 5 skipped. First B full run: 4 failed / 2542 passed / 5 skipped: three debug-only version assumptions and one production composed-test hardcoded A assertion. The production assertion now checks the exact approved set and actual child identity. The independently packaged debug derivative remains A-only; B explicitly tests its version refusal and skips its two success-only tests, rather than silently qualifying that derivative.
- Additional `OMIT_CHECK` RED: 1 failed / 28 passed, then 29 passed with the safety exclusion.
- Review remediation (four-lane R1, Lane C content-evidence blocker): cross-version assertions now compare the original baseline message's full row, complete audit rows, idempotency record, production payload-read bytes (against the known synthetic sha256) and the baseline idempotent replay after every phase, including both SIGKILL paths; each hashed field also has a perturbation negative control. First RED: 12/12 failed because the worker emitted no durable-row evidence; after the worker change, 12/12 passed under each parent runtime (`task4-content-red/green-*`).
- Edit incident (caught by the gates, retained in `formal2-*`): while adding the parity comment, the `REQUIRED_SQLITE_CAPABILITIES` declaration line was accidentally deleted; both runtimes' typecheck/build exited 2 and the dependent full/plugin suites failed before the one-line restore. `formal3-*` then passed all twelve gates. No behavior change was involved and no failure was erased.
- Final active diagnostics reported two inherited auxiliary rule findings in migration/recovery, verified present in baseline HEAD; four probes could not confirm clean. No blanket LSP-clean claim is made. Both actual TypeScript compiler gates passed.

The full-suite five skips are four gated plugin-package cases (separately exercised by the seven-test gated run) and one wrong-file-owner case requiring root/chown authority. B adds the two documented A-only debug success cases. `test/tunnel/real-client-compat.test.ts` is explicitly excluded throughout: it would execute an installed real client, which this handoff forbids. It is not counted as tested.

Test-count growth from the first full run to the formal runs is suite expansion, not churn: +12 `runtime-cross-version` tests, +2 `OMIT_CHECK` refusal cases, and +1 from converting the single-child stdio multi-session test to a two-child `it.each` (2551 → 2566 total).

## Limits

Only Darwin arm64 was newly exercised. The existing Linux x64 platform policy is unchanged; this work provides **no new actual Linux binary qualification evidence**. Other platforms and Node versions remain refused. Exact runtime eligibility does not assert binary provenance authenticity beyond the recorded acquisition checks, nor that host and child must share an executable. Frozen Store schema, migration ledger, trust-root, routing, capability and ACK contracts are unchanged. Acceptance does not authorize push, release, deployment, global configuration or a real-client run.
