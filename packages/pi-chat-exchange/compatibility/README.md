# Tunnel Client compatibility

Users install the official latest stable Tunnel Client. The pinned PR version is a regression target, not a user installation requirement.

`tunnel-client.json` schema version 1 is the maintained matrix. Each combination binds CE version, baseline commit, actual runtime source digest, client release/source commit, date and environment. `worktree: modified` means the tested patch was not committed at that baseline; its manifest is retained in the sanitized evidence. Never describe the baseline commit alone as the tested patched code.

| Client | Recorded qualification | Limits |
|---|---|---|
| 0.0.16 | Historical local lifecycle and manual bidirectional Cloud VERIFIED | Original RC source; macOS arm64; not proof for newer client or modified source |
| 0.0.17 | NOT_VERIFIED | No inference from neighboring versions |
| 0.0.18 | NOT_VERIFIED | No inference from neighboring versions |
| 0.0.19 | COMPAT-03 lifecycle and manual bidirectional Cloud VERIFIED | COMPAT-02 source; macOS arm64; real namespaced Cloud NOT_VERIFIED |

Statuses are `VERIFIED`, `FAILED`, `NOT_VERIFIED`, `BLOCKED`. A `VERIFIED` lane must include its correct evidence kind and a repository-relative sanitized evidence file. Imported evidence includes source-artifact hashes, message/receipt identifiers and cleanup outcomes. It excludes Tunnel/organization IDs, credentials, payloads, private configuration, machine-local paths and raw runtime logs. The original full evidence remains operator-managed; the repository summary is reviewed evidence, not a cryptographic proof that a human performed Cloud testing.

## Checks and release rules

- **Rule:** PR regression uses the maintained fixed client (currently 0.0.19). **Scope:** CI `tunnel-compat` job. **Check:** matrix/gate/workflow tests, official archive verification, real local client lifecycle. Existing `validate` job owns full TS tests/build/typecheck. **Failure:** REWORK. Configure `Tunnel compatibility (pinned 0.0.19)` as a required branch-protection check externally; workflow code does not change GitHub settings.
- **Rule:** monitor official latest independently of PRs. **Scope:** `tunnel-client-latest.yml`, daily 06:17 UTC and manual. **Check:** GitHub official stable release API and tag commit; full official Linux amd64 bundle, signed SLSA provenance (official signer workflow/ref/source/signer digest, hosted runner), SHA256; then real `run`/health/Stop/fault tests against loopback synthetic resources. **Failure:** workflow FAILED; inspect sanitized result. No downgrade, matrix edit, Issue or PR creation.
- **Rule:** publication needs current latest evidence for current runtime source. **Scope:** both npm preflight and publish entry points. **Check:** official latest is queried again; a same-run `tunnel-latest` job supplies a no-Cloud result less than 24 hours old; exact client/source/CE version/runtime digest and required outcomes must match. Reviewed matrix lifecycle plus manual Cloud must match the same client/source/runtime. **Failure:** RELEASE_NOT_READY. Missing network evidence fails closed.

`runtimeDigest` covers all `src/`, Pi extension files, the packaged `native/tunnel-keychain.swift` helper, and runtime package metadata (name/version/engines/dependencies/peer dependencies/Pi entry). Author-only scripts, tests, docs, workflows and other Native source do not invalidate manual runtime evidence; the Swift helper is included because CE resolves, compiles and runs it. A runtime change requires new authorized evidence; CI cannot refresh manual Cloud. Both the current source digest and the full artifact are still subject to normal build/package/release checks. Changing this digest policy is itself a release-policy change requiring review.

The release client job has only `contents: read` and no OIDC write permission. Its result artifact is downloaded from the same workflow run. The protected publish job rechecks latest immediately before each preflight/publication; it never executes the downloaded client under its OIDC write permission. Green compatibility evidence does not grant publication authority.

## Coverage boundaries

Automated CI runs Ubuntu x64, Node 24.21.0, an isolated HOME and explicitly selected non-production node-sqlite. It executes the official binary against a loopback synthetic control plane and actual CE MCP child. It checks legacy and synthetic namespaced IDs, health/poll, normal SIGTERM, child failure exit and Stop during failure, and exact process cleanup. It does not use production credentials, Setup, Pairing, cloud accounts, real Cloud E2E or production Native qualification. Existing Native CI covers its separate driver contract.

Namespaced local tests are not real namespaced account evidence. A forced child failure can leave ownership in the disposable synthetic Store; no recovery or takeover is attempted. Manual COMPAT-03 separately verified preserved ownership and refused automatic recovery. CI uploads only the structured result JSON, never downloads, HOME, Store, configuration or raw logs. The summary always labels Cloud NOT_VERIFIED by CI.

## Maintenance

After an official release, inspect the independent monitor. Obtain authorization for missing real lifecycle/Cloud resources, perform a bounded test and safe Stop, review the sanitized evidence, then explicitly update the matrix. Never auto-promote a monitor result to manual Cloud VERIFIED. Preserve failed/blocked entries and their scope when adding new qualification. A new unsupported platform is NOT_VERIFIED, not a silent successful skip.

Local checks (from package directory):

```sh
node scripts/tunnel-compat.mjs validate
node --test scripts/test/tunnel-compat.check.mjs scripts/test/tunnel-workflow.check.mjs
pnpm run build
# Linux x64 only; isolated official install, no Cloud:
node scripts/tunnel-compat.mjs run /tmp/ce-tunnel-result/result.json latest
# Release evidence gate, no publication:
CE_TUNNEL_COMPAT_RESULT=/tmp/ce-tunnel-result/result.json node scripts/tunnel-compat.mjs gate
```

Official sources: [releases](https://github.com/openai/tunnel-client/releases), [installation and release verification](https://github.com/openai/tunnel-client#install-with-homebrew), [stdio upgrade/rollback](https://github.com/openai/tunnel-client/blob/v0.0.19/docs/configuration.md#stdio-failure-policy-upgrade-and-rollback).
