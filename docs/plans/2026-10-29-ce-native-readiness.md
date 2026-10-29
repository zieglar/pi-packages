# HANDOFF-PI-CE-NATIVE-READINESS-01 — bounded implementation plan

Baseline: Private `main@6d639385de058fa76e0eb5635868fc25f9e57b9f`; Public Export PX-0015 `bb545ae0b686cac4761f47e3e56e1f268ae0cc4f`. No other tracked working changes; preserve untracked `AGENTS.md` and `.herdr-web-ui/`. New export must directly descend PX-0015. No push/publish/deploy.

1. Pin only immutable ce-sqlite-v0.1.0 after independent tag/source, eight-file digest and seven-subject attestation verification. Keep source SHA `a8386aafd657c84825b2905847f34a43d5b91e1e`, ABI 1 and bundled SQLite 3.54.1. Production pin test must fail before and pass after the edit.
2. Add read-only Native readiness classification using existing selection/cache verification. No new state database. Startup detection must not download, create a Store, change selection or start Tunnel. Notify once per extension factory while preserving management commands.
3. Implement explicit `/ce-native status/install/verify/repair/check-updates`. Install/repair require user action and verify before selection changes. Updates are discovery only; `latest` never changes trust or driver selection.
4. Revalidate readiness immediately before real Tunnel start. Do not block status or owned stop. Use existing runtime/Store admission and errors. No implicit fallback or replay.
5. Preserve Windows refusal and document WSL2/Linux path without claiming WSL2 integration. Attribute Node 22.19.0 failures without hiding blockers.
6. Run targeted production-pin/readiness/command/tunnel tests, relevant storage and Host tests, typecheck/build/package checks, docs/link/privacy checks. Keep first failures and distinguish mock fixtures from actual binary/Host evidence.
7. Commit only task files, run four fixed-commit independent reviews, remediate blockers, then local Public Export PX-0016 directly on PX-0015 and append-only Ledger. Production publication, Hosted CI and npm publication remain separate authorization.

No new Delivery/Ownership/Recovery/Completion authority, no dynamic remote trust protocol, no Store schema changes, no automatic downloads/upgrades/repairs/fallback.
