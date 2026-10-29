# CE Native default final implementation plan

> Continuation of HANDOFF-PI-CE-NATIVE-DEFAULT-01. User supplied and authorized final design; no separate handoff or production pin authority.

**Goal:** Default only to verified Rust Native SQLite, retain explicit non-production node:sqlite, follow Pi 1.3.0 Node engines with driver-specific safety checks, and finish bounded local implementation/export while production publication remains blocked on separately authorized pins.

**Architecture:** Keep the current driver/connection/transaction/store seams and schema unchanged. Missing selection resolves Native; only explicit node-sqlite loads its built-in module. Native errors never select Node. Production NATIVE_COMPAT remains byte-identical. Isolated qualification uses already verified ce-sqlite-v0.1.0 manifest/binaries in an independent HOME.

**Tech stack:** TypeScript, napi-rs/rusqlite existing addon ABI1, Pi1.3.0, Vitest/node:test, GitHub Actions.

## Baseline

Private main da7cbd83aef8cfc45cdb0f9a731083679f4c8165, origin/main cached ahead146/behind0. Preserve four dirty Native-default files and untracked AGENTS.md/.herdr-web-ui. Binary diff backup retained outside repo. Public export branch export/ce-docs-i18n-01 at 2f3a4670b52b6ad6e661ba44f7527f5d1c9268f7, no upstream; parent chain PX9–14. New export must have exactly this parent. No reset/rebase/merge/cherry-pick or push.

## Tasks

1. Read installed Pi1.3 manifest/API and relevant dependency engines; verify its declared >=22.19.0 independently from tested range. Acquire official checksum-verified Node22.19.0 if absent; reuse retained 24/25/26 binaries and historical evidence.
2. Fix temporary test-HOME handling (unique private directory, Native lane must not silently select Node); add process-level tests proving Native absent/corrupt/pin/ABI refusals and zero node:sqlite access, with explicit Node positive control. Keep transaction/recovery/ownership semantics unchanged.
3. Set CE engines to Pi declared >=22.19.0 after lowest-version Native/API validation. Add canonical minimum check on Native path, retain legacy Node-specific version/SQLite refusals only for explicit compatibility driver. Update contract expectation and diagnostics. Do not expand to unsupported platforms.
4. Fix tests directly impacted by Native default, including child fixtures that directly open built-in SQLite; separate explicit cross-driver tests from production Native lane, preserve their existing assertions.
5. Reduce npm docs to English README and LICENSE, preserve runtime closure and necessary operator scripts. Correct README outbound links to public GitHub pages. Keep tarball/version unchanged in registry; local pack must exclude nonessential/Chinese docs, private state, Native binaries and lifecycle hooks. Fix release-preparation EN/ZH safety assertions and Vitest accidental node:test collection.
6. CI: real immutable Release download, exact SHA/hash + seven attestation subjects, isolated manifest/cache, lowest Pi Node plus main Node representative; Native default/failure/explicit-node tests and packaging/contracts. Do not trust mock addon or modify production pins. Hosted execution pending because pushes forbidden.
7. Real qualification: lowest Pi Node Native + Store, existing24.19/24.21/24.22.2/25.2.1/25.9/26.12.1 representatives; selected risk suites, cross-version Store + crash/WAL; Pi1.3 first-run in isolated PTY with synthetic Store. Reuse existing 1011/1009/1003 runs to avoid pointless repetitions; rerun failures after direct fixes. Record Linux/hosted gaps honestly.
8. Synchronize current EN/ZH Native/runtime/install/architecture/troubleshooting and source-vs-published boundaries; preserve historical release notes/qualification scope. No Wayforge product dependency. Humanizer/qu-ai-wei prose-only if useful.
9. Freeze exact candidate commit after meaningful checks. Run four context-isolated lanes A diff/privacy/docs, B authority/frozen architecture, C validation/coverage, D standards/maintainability on same fixed target. Correct blockers and re-review deltas.
10. Create new bounded Public export onto PX14 with explicit path/blob map; exclude Private governance/evidence/skills/historical records. Append ledger states, git-verify+negatives, document public SHA and unmodified production pins. Stop for acceptance. No publish-ready or production-enabled claim until separate pin/release authorization.
