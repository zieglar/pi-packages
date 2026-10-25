# Distribution repair — Task 1 implementation evidence

Baseline: `affc05d024d0bef4254eaf14de7d521815c720ea`, independent `fix/ce-distribution-fix` worktree. Approved plan is `docs/plans/2026-10-25-distribution-fix.md`.

Evidence retained at `/private/tmp/ce-distribution-fix/implementation/`: exact allowlisted environment, copied Node v24.21.0, frozen author install with scripts disabled, and `commands.jsonl`/`evidence/*.log`. Nothing in the previous installation-amendment evidence was overwritten.

- Genuine RED: `distribution-native-red-corrected.log`, 1 failed / 4 filtered: native pack after successful build lacks `package/dist/bin/mcp-stdio.js` under original gitignore fallback.
- Earlier harness failures retained: initial fixture omitted `.gitignore`; isolated PATH also initially lacked npm's bin link (`ENOENT`). Neither is counted as product RED. Missing validator tests initially report MODULE_NOT_FOUND, also not counted as product RED.
- GREEN: `distribution-green-expanded.log`, 7 passed, zero failed. Missing dist/root/entry/transitive module and symlink-root refusal; native inventory and no consumer hooks.
- `typecheck-task1`, `task1-build`, `task1-check`, `task1-author-pack`: exit 0. Source-side editor cannot resolve this worktree's intentionally absent node_modules; real frozen isolated `tsc` is the typecheck evidence.
- Existing Vitest guard-hoisting warning remains; no runtime/client tests were run.

The explicit author command builds in the complete workspace, validates local runtime imports and native npm inventory, then packs with scripts disabled. The consumer receives JS runtime plus Pi TS entry modules, native helper, operator scripts and public documentation; no consumer tsconfig/build contract, source maps, dev tests, node_modules or private state. Bare `npm pack` is not the supported author validation command.

Host-provided dependency warning review: keep pinned dependencies unchanged in this repair. Compiled ESM imports `@earendil-works/pi-tui` through secure-input and TypeBox value helpers directly outside the Pi TS loader. Simply deleting these dependencies or making them optional peers can break independent Node ESM resolution. The independent install must retain physical runtime dependencies. Pi 1.3.0 warnings are recorded rather than hidden; deduplication/peer redesign requires separate evidence and is not necessary to repair the proven missing-dist failure. No dependencies or lock versions changed.

This is implementation evidence only. Installed-host and first-run validation belong to Task 2; full-suite/plugin and fixed-SHA independent review remain parent-owned. No cloud transport claim.
