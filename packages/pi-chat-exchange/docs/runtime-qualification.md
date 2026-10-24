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

A is the existing local exact-version installation. B is the official `node-v24.22.1-darwin-arm64.tar.gz`, downloaded privately, SHA-256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7`, compared against the official HTTPS SHASUMS. Detached signatures were **not** verified. Complete inventories, absolute executable paths, acquisition provenance and executed command/exit envelopes are in the local evidence bundle `ce-runtime-qualification-3s2AZH` (`formal-identities.json`, `initial-identities.json`, `acquisition.json`). No global runtime configuration changed.

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
