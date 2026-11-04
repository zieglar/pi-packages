# Hooks management R2: parent review synthesis

Handoff: `HANDOFF-CE-HOOKS-MANAGEMENT-01`.
Disposition: **BLOCKED_AT_DESIGN_GATE. No management feature implemented.**
Baseline: `894ea9eddd88841fa667748cda7af98815b99785`.
Worktree: `/Users/zieglar/Code/pi-packages-ce-hooks-management-01`.
Branch: `feat/ce-hooks-management-01`.

This separate report records both R2 reviews, parent verification, corrections and the remaining design decision. It does not modify the three reviewed files, close the feature gate or authorize production work.

## Fixed R2 target and review results

Both R2 reviewers reported identical start/end hashes and unchanged HEAD. The parent rechecked the same hashes after both completed.

| Reviewed file (package-relative) | SHA-256 |
|---|---|
| `docs/plans/2026-11-04-ce-hooks-management-design.md` | `235d91fea4226109b1828a90a8fd9955de58728c65db1bac257bbe62aa277a69` |
| `test/tunnel/live-session-migration.test.ts` | `a00b30e0510571741cf149ee0d8ac4601969bb381c314afc4b11ed26f6d9dc67` |
| `test/tunnel/hooks-management-characterization.test.ts` | `e77bb09735f711b059809e0ec24aed9d869bc8b11aa84b09c341d5197076bbe1` |

- `hooks-mgmt-security-r2`: **PASS for BLOCKED-report posture and test-diff only**. The medium confirmation/incarnation finding remains unresolved. Reviewer session: `3d26cf4f-ca02-40ff-ab93-48885bafe8db-ba9f1fa2-2a4c274a-a476`.
- `hooks-mgmt-plan-r2`: **PASS for report quality/correctness only**, with follow-up findings recorded below. Reviewer session: `4d17acf1-9030-42a3-8b20-79560ae7744d-48806a70-f67b9ab5-5e00`.
- Both used the configured `magpie/group/expert` route. No cross-family independence claim is made; reviewers did not independently run the tests.

The original plan review was blocked by this parent's mid-review document change. R2 corrected that process: targets and dependency links remained unchanged throughout both R2 reviews. Neither R2 PASS authorizes runtime implementation or waives adoption binding or Pi runtime/reload continuity.

## Parent disposition of findings

### Confirmation-to-adoption binding remains a blocker

The real STOPPED Profile lock does not fence independent Pi live-policy writers. An additional read catches changes before that read, not commits after it; a rule authored for one registration epoch can be admitted by a fresh MCP composition after revoke/reauthorize advances the epoch. R2 correctly refuses to call a warning or pre-rename check a fix.

No new enabled live inbound rule, executable-changing edit or disabled-to-enabled publication is justified by the proposed same-ref publisher under confirmation-time-incarnation semantics. Unknown durability never authorizes rebase, retry, rollback or implicit lifecycle work.

### Rule authority: accept the requirement, distinguish the suggested mechanism

Plan finding F1 correctly warns that an amendment scoped only to recipient identity could underspecify execution authority. Future design must bind the exact operator-authorized static rule (command, arguments, event, target, timeout and enabled state), its sender-side binding/publication identity, and the intended target registration incarnation through adoption and before execution, including queued work. It must specify narrowing/removal and old/new runtime behavior. Identity binding alone is not a proof of that complete requirement.

However, an intersection with the receiving Pi registration's existing `hooks` array would mix sender authorities. The parent does not adopt that mechanism:

- `docs/hooks.md:13-15` and `skills/ce-hook-script/SKILL.md:14-20` place ChatGPT-to-Pi rules in MCP binding `config.hooks` and Pi-to-ChatGPT rules in the sending Pi registration. The recipient registration is not the source of inbound command authority.
- `effectiveMcpHookRules()` (`src/tunnel/multi-session-policy.ts:185-189`) intersects **loaded MCP config rules with current MCP config rules**, plus recipient registration admission. It does not intersect MCP rules with Pi registration Hook arrays.
- Live `hookAllowed()` (`src/tunnel/live-mcp-composition.ts:49-54`) checks its fixed sender `config.hooks` and loaded/current recipient continuity. MCP entry wiring (`src/bin/mcp-stdio.ts:118-124`) uses that function. The absence of a matching inbound rule in Pi registration `hooks` is therefore not, by itself, a violation of the current sender-owned contract.

A separately designed chain record for MCP rule facts is one possible authority amendment; it is not an existing required field and must not be silently conflated with Pi outbound rules. This report chooses no new registry, schema, chain ownership or grant mechanism. A future design must provide an enforceable full rule/binding/incarnation invariant and tests, rather than infer either safety or a new chain-record requirement from the current report.

### Pi messaging and reload continuity remains a blocker

`assertLiveRegistrationContinuity()` starts at `pi-extension/multi-session-runtime.ts:97` (correcting R2's line 96 citation). It requires own loaded/current Hook equality, participates in normal operations and reload transfer, and underlies `effectiveLiveRegistration()` at line 107. Merely adding a Hook-update intent can therefore deny ordinary messaging or same-Owner reload. The amendment must address old/new factories, own/unrelated changes, failure and ownership continuity; no takeover or implicit repair is authorized.

### Terminology, test claims and provenance corrections

- R2's phrase “composition admission method” means `hookAllowed()`, the **Hook rule-allowance check**. The composition's business-operation `admission` callback is distinct.
- In `after-final-recheck`, live revoke/reauthorize occurs while the Profile lock is held, after the modeled check and before candidate publication. In `after-candidate-save`, it occurs **after that lock releases**, before fresh-composition adoption. The shared test comment's lock-held statement applies only to the first phase.
- Those cases stage immutable candidate files and leave the Profile unchanged. They prove lack of writer coupling/authoring-incarnation binding in the tested primitives, not a production activation transaction or that a reread performed after the mutation would miss it. The read-then-commit race is also supported by the separate source contracts; no atomic policy/Profile commit exists.
- The runtime-continuity case calls real guards on typed synthetic snapshots. It does not prove accepted chain publication, full `run()`/`transfer()` behavior, actual Pi reload or MCP process adoption.
- The migration test header names its original Session Onboarding handoff. Its three added Hook-management cases belong to this handoff; the existing file and header were retained to preserve the fixed review target.
- These are report corrections, not changes to the three files whose hashes the reviewers approved.

## Verification with retained command and exit evidence

After both R2 reviews completed, the parent reran the unchanged target to produce self-contained logs. Each new log includes Node version, working directory, exact argv, output, exit code and signal. The suite log names all ten input test files in its command header.

Node: **v24.21.0**, selected by `mise exec node@24.21.0 --`.
Working directory: the worktree's `packages/pi-chat-exchange`.

| Check | Command after the mise prefix | Result | Evidence log |
|---|---|---|---|
| Build | `node node_modules/typescript/bin/tsc -p tsconfig.build.json` | exit 0 | `/tmp/ce-hooks-management-01-r2-evidence-build.log` |
| Package typecheck | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0 | `/tmp/ce-hooks-management-01-r2-evidence-typecheck.log` |
| Targeted tests | `node node_modules/vitest/vitest.mjs run --maxWorkers=4` plus the files below | 10 files, 104 passed; exit 0 | `/tmp/ce-hooks-management-01-r2-evidence-suite.log` |

Inputs: `test/hooks/hook-config.test.ts`, `test/hooks/mcp-hook-config.test.ts`, `test/hooks/hook-runner.test.ts`, `test/hooks/multi-session-hook-policy.test.ts`, `test/tunnel/live-session-policy.test.ts`, `test/tunnel/live-session-migration.test.ts`, `test/tunnel/hooks-management-characterization.test.ts`, `test/tunnel/messaging-config.test.ts`, `test/tunnel/messaging-config-security.test.ts`, `test/tunnel/multi-session-policy.test.ts`.

The previous typecheck log was empty; it showed no diagnostics but could not independently attest an exit code or Node version. The new nonempty log resolves that evidence limitation without rewriting the historical log. Temporary dependency symlinks were created only after both reviews ended, then removed before this report was written. No dependency installation is claimed. Existing test-support mock-hoisting warnings remain; no test failed.

Tests exercise isolated profiles/policy files and controlled harmless test processes where the existing runner suite requires them. No personal script, production Store/configuration, real Tunnel lifecycle, actual UI, real peer or end-to-end reload was exercised. “No personal script execution” must not be shortened to “no scripts at all”: controlled package test fixtures can run.

## Current artifact and authorization state

The worktree has the three reviewed design/test paths plus this report; production runtime source remains unchanged. No local commit, installation, production config update, Hook enabling, personal script execution, Tunnel Stop/Start, merge, push, PR or release was performed. Existing parent-worktree untracked files remain untouched. Earlier CE audit #74 described an intermediate proposal; this report supersedes its suggestion that disclosing the adoption residual could satisfy the gate. No new acceptance or scope choice is inferred from that earlier message.

## Next decision

The requested active notification and complete two-sender management feature is **not delivered**. Recommended next step is explicit authorization for the bounded amendment **design** covering both full sender-rule/binding/incarnation enforcement and Pi Hook update/reload continuity. It should reuse current publication primitives where sound, preserve sender authority and existing core/Store/protocol semantics, and return for review before implementation. A reduced read-only/disabled-draft authoring scope is another option, but does not meet the active notification goal. Neither review PASS chooses that scope, grants a safety waiver, authorizes deployment or supplies the missing amendment.
