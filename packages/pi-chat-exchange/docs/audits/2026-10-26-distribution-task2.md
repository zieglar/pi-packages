[English](2026-10-26-distribution-task2.md) | [简体中文](2026-10-26-distribution-task2.zh-CN.md)

> Historical evidence or design record. Claims, commands, test results and limitations below describe the recorded phase, not current support or release eligibility.

# Distribution repair: Task 2 + scoped-path grammar evidence

Baseline: Task1 commit `349116b65da1a20c6260394b4f2fd70a3afb5c0b` on `fix/ce-distribution-fix`; user-approved narrow scope extension: admit `@` as an ordinary command-path character only.

## Grammar change (only product edit)

`src/tunnel/profile.ts` `COMMAND_PATH`: `/^\/[A-Za-z0-9_./ -]+$/` → `/^\/[A-Za-z0-9_./@ -]+$/`. Absolute-path, normalization, quoting, argv token, option-segment, credential-shape and expansion defenses are byte-identical. No other contract touched.

TDD: `grammar-scoped-red`: 3 scoped positive roundtrips RED (node/script/binding incl. quoted space-bearing scoped path), 4 negative groups already passing; `grammar-scoped-green`: all 43 profile tests GREEN; `grammar-neighbors`: 18 setup-profile/portability tests GREEN.

## Final fixed-artifact verification (approved copied Node v24.21.0, isolated frozen deps)

Final archive: `zieglar-pi-chat-exchange-0.1.1.tgz`, SHA256 `34e612534e6b746a49c63c508fcd8f05aacad8e85251812fa827d1465fe484a0`.

- `final-targeted`: 74 passed / 0 failed (profile, setup-profile, portability, distribution, guardian-cleanup).
- `final-smoke`: real npm install of the exact final archive + independent Pi 1.3.0, formal `pi install`/`pi list`, real PTY: doctor (client=CE_EXECUTABLE_UNTRUSTED safety diagnostic), Setup first-save with masked credential + Advanced Messaging authorization + routing-change confirmation, `/ce-tunnel convert`, `/new`, `/ce-tunnel register pi/distribution`, `/reload`, `/ce-tunnel activate` (explicit focus change from default Cancel), `/ce-tunnel deactivate`. Host exit 0; evidence `<final-installed-host-evidence>` (final archive SHA256 `34e612…` recorded in its `archive-sha256.txt`; earlier equivalent pass on the pre-docs artifact retained at `<earlier-installed-host-evidence>`) with result.json PACKAGE_INSTALL/REAL_HOST_LOAD/FIRST_RUN=PASS, CLOUD_TRANSPORT=NOT_VERIFIED. No client execution, no Tunnel start, no business message/read/ACK.
- `final-build`, `final-check`, `final-typecheck`: exit 0.
- Intermediate retained first-failures: `smoke-first-save`/`smoke-full` (activate confirmation default-focus and wording) and `<initial-installed-host-evidence>` (successful activation observed; assertion needle wrong). Nothing patched to green.

## Supervisor

Outer runner delegates lifetime to committed guardian/anchor via `supervised_pty.py`; guardian cleanup regression (`guardian-cleanup.test.ts`) proves driver SIGKILL and outer-timeout death both yield confirmed groupDead/anchorReaped barriers without Python finally. Final smoke barrier: successful=true, exit 0.

Known first-failure residue (unresolved, operator-pending): 8 synthetic anchor groups from pre-correction supervisor runs remain alive; read-only liveness re-check recorded in `guardian-residue-liveness-readonly.json` (all 8 still identify their fixture root). No signal authority exists (no owned handle/nonce channel); none were signalled. Not counted as cleanup PASS.

## Distribution artifacts/tests

`package:pi-extension` script lane added; default `pnpm test` excludes the heavy lane (fail-loud when reached without opt-in env). Pack validator now requires native/operator assets in the npm dry-run inventory (3 RED→GREEN exclusion tests). Official consumer/producer guide: `docs/independent-install.md`, pointers added in README/tunnel-setup/pi-extension README; commands match the executed smoke.

Full default suite, plugin tests and independent fixed-SHA review remain parent-owned.
