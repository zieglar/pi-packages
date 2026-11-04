# CE Hooks management implementation and local verification

Handoff: `HANDOFF-CE-HOOKS-MANAGEMENT-01`.

Disposition: **IMPLEMENTED/TESTED — fixed plan, implementation and security reviews PASS**. This is a local implementation delivery. Production deployment and Handoff closure are separate decisions.

## Authorization and baseline

The user's later full implementation, isolated verification, review and local-commit authorization supersedes the design-round no-implementation/no-commit posture in the frozen historical documents. Work is confined to `/Users/zieglar/Code/pi-packages-ce-hooks-management-01`, branch `feat/ce-hooks-management-01`, based on `894ea9eddd88841fa667748cda7af98815b99785`.

No production configuration, user installation, personal command, shared Tunnel, Owner recovery, merge, push, PR or release was changed or performed. Temporary dependency symlinks reused the existing parent checkout dependencies during verification and were removed before freezing the review target. No package installation was performed.

The reviewed D1 design is unchanged, SHA-256 `d8c72175a3472c569a04a5cebe1ebedcc301c0b0a00ee15095a3cb1e53644906`. Its locator/reader clarification report is unchanged, SHA-256 `dd4ca832887d92f10d9c53cc0a555d53f20c6bd50ffb5318a827297dba8eabc9`.

## Delivered behavior

- Native `/ce-hooks` and `/ce-tunnel hooks` list, add, edit, enable, disable and remove sender-scoped rules. Pi outbound editing is restricted to the current native Session. Incoming rules are the MCP sender's `config.hooks`; receiving Pi outbound rules grant no incoming authority. The whole candidate is previewed and explicitly confirmed. Legal rule IDs such as `cancel`, `add` and `review` remain usable.
- Loaded-process rule audit remains available in the native TUI for explicit `CE_ALLOWLIST`, legacy and unavailable/noneditable selected policies. Headless invocation remains inspection only. It does not reread changed authoring files as though they were adopted rules.
- Explicit offline v1 → v2 upgrade preserves the same history, v1 prefix, identity, registrations, tombstones, epochs, read/ACK generations, presence and Pi Hook arrays. One pinned upgrade marker introduces closed v2 transitions and empty incoming consent. Old readers fail closed. No Core, Protocol or Store schema/authority semantics change.
- Pi Hook generations suspend old starts after any own-array change, including an identical-byte ABA restoration. Ordinary messaging retains its identity, permission-generation, failed-latch and mutex checks without requiring Hook equality. Official reload transfers the same mapping and Owner lifecycle; failed reload does not revive the old runner or acquire a substitute Owner.
- Incoming consent pins an exact immutable binding generation and exact per-rule Endpoint/native Session/epoch targets. Dynamic active registrations can be targets even when absent from the original static recipients list. Consent is captured at process load, and each actual start checks current selection, consent generation and target incarnation. Old processes do not gain late consent or revive after ABA; new processes cannot substitute a new target epoch.
- Real STOPPED Profile locking, expected-tip exclusive publication and checked Profile rename remain separate boundaries. Crash recovery requires exact candidate path, operation evidence, validated locator/intent and a fresh explicit continuation. Continuation selects an already-published candidate without publishing another grant or upgrade marker. Unknown durability does not trigger automatic retry, rebase or rollback.
- Safe test requires separate native confirmation and runs only a fixed harmless local fixture with synthetic metadata-only stdin. Saving, listing and preview never execute configured commands. Safe test does not establish that a personal script works.

## Validation

Environment: Node `v24.21.0`, Vitest `4.1.11`; package cwd `/Users/zieglar/Code/pi-packages-ce-hooks-management-01/packages/pi-chat-exchange`.

Fresh final parent verification: **39 test files, 314 passed and 1 skipped**, in one complete mandatory command (exit 0, 43.31 seconds), including the legacy TUI audit and both new legal-ID regressions. The skip is the existing wrong-file-owner test requiring root/chown authority (`multi-session-policy-validation.test.ts`). Existing support-file `vi.mock` hoisting warnings remain; no test failed. This is a targeted suite, not the complete repository test matrix.

All of the following returned exit 0:

```sh
mise exec node@24.21.0 -- node node_modules/typescript/bin/tsc -p tsconfig.build.json
mise exec node@24.21.0 -- node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
mise exec node@24.21.0 -- node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop pi-extension/index.ts
mise exec node@24.21.0 -- node scripts/check-contract.mjs
mise exec node@24.21.0 -- node scripts/check-native.mjs
```

The test command was:

```sh
mise exec node@24.21.0 -- node node_modules/vitest/vitest.mjs run \
  test/tunnel/live-session-policy-v2.test.ts \
  test/tunnel/live-session-policy.test.ts \
  test/tunnel/hooks-management.test.ts \
  test/tunnel/hooks-management-ui.test.ts \
  test/tunnel/hooks-management-characterization.test.ts \
  test/tunnel/live-mcp-hooks-v2.test.ts \
  test/tunnel/live-mcp-hooks-v2-stdio.test.ts \
  test/host/mcp-binding-config-v2.test.ts \
  test/endpoints/pi/hooks-v2-runtime.test.ts \
  test/endpoints/pi/live-hooks-v2-integration.test.ts \
  test/tunnel/live-adoption-probe.test.ts \
  test/tunnel/live-connection-status.test.ts \
  test/tunnel/live-session-migration.test.ts \
  test/hooks \
  test/host/mcp-binding-config.test.ts \
  test/host/mcp-binding-config-ack.test.ts \
  test/tunnel/messaging-config.test.ts \
  test/tunnel/messaging-config-security.test.ts \
  test/tunnel/multi-session-policy.test.ts \
  test/tunnel/multi-session-policy-validation.test.ts \
  test/tunnel/live-mcp-composition.test.ts \
  test/endpoints/pi/extension-hooks.test.ts \
  test/endpoints/pi/extension-multi-hooks.test.ts \
  test/endpoints/pi/extension-hooks-real.test.ts \
  test/endpoints/pi/live-session-profile.test.ts \
  test/endpoints/pi/live-session-runtime.test.ts \
  test/endpoints/pi/live-session-onboarding.test.ts \
  test/bin/stdio-messaging.test.ts \
  test/bin/stdio-multi-session.test.ts \
  test/tunnel/live-mcp-stdio.test.ts \
  test/endpoints/pi/extension-live-hooks-v2-real.test.ts \
  test/tunnel/hooks-management-legacy.test.ts \
  --maxWorkers=4
```

The actual Pi extension tests execute a temporary benign Hook through the real Host and private Store, verify send availability across Hook-only changes, old-runner ABA denial, exact same mapping/Owner/Session/fencing across official reload and fail-closed behavior after epoch change. The actual MCP stdio child tests verify both original A and dynamically registered B against a static-A launch, late consent, explicit process adoption, ABA denial and metadata-only fixture input. Configuration/TUI tests use existing native component harnesses; no full interactive terminal session or production transport was exercised.

Self-contained local logs retain cwd, exact argv, Node version and exit status at `/tmp/ce-hooks-final-r4-{build,typecheck,extension-typecheck,contract,native-static,suite}.log`. Red/green policy-race and manager remediation logs are `/tmp/ce-hooks-v2-policy-race-{red,green}.log` and `/tmp/ce-hooks-v2-ui-r2-{red,legacy-red,green,final}.log`. The legal-ID regression failed before the fix in `/tmp/ce-hooks-ruleid-red.log` (two expected failures, 34 passing); final R4 suite verifies both now pass. These temporary logs are local evidence and are not durable repository artifacts.

An active LSP probe checked the real extension integration test and four runtime/binding files. One was confirmed clean, two had only auxiliary style warnings, and two push-only server checks were inconclusive. The compiler checks above provide the successful type-check evidence; an empty/silent LSP result is not treated as proof of cleanliness.

A subsequent active LSP probe of the final three-file policy/test delta found two files clean and only auxiliary style warnings in the policy file, with no TypeScript errors reported. Compiler verification remains the authoritative typecheck result.

## Fixed review and remediation

Initial implementation spec review requested three functional fixes: dynamic v2 targets must not require old static recipients, loaded-rule audit must remain available for legacy/noneditable TUI contexts, and valid rule IDs must not collide with menu action IDs. All three were fixed with focused failing tests followed by passing verification. Real outbound/reload and dynamic-target stdio integration tests were added before the final freeze.

R3 plan review then required the omitted legacy audit target and explicit continuation/stop conditions in the implementation plan. The missing test passed separately; R4 subsequently ran the exact complete mandatory suite in one command. R3 implementation and security reviews both passed. The implementation reviewer identified a nonblocking mismatch: the Hook grammar accepts `cap_0123456789abcdef`, but the consent target parser reused an identity credential-shape guard. R4 fixes only `ruleId` to follow the existing Hook grammar; endpoint, native Session and actor guards remain unchanged. Two regression tests failed before the fix and passed in the final suite.

Final review target: 33 files against the baseline; manifest `/tmp/ce-hooks-management-final-r4-manifest.json`, SHA-256 `f7d39edaefffb200a1ea95b93653b40e687ae570898ce29f4e3502caac467712`. R3 manifest was `03c35da8c9f081c2401b7b06c3ec1931e6dd6c857d6c283514d55c0f19d394d7`; R4 changes only the policy target-ID guard and its two regression test files. All other 30 files retain their R3 review hashes. Source, tests and docs are unchanged during each fixed review. This final report is added after reviewers return and is outside their frozen implementation target.

Final plan/evidence, implementation and security reviews all passed. Reviews use context-isolated role sessions and routed model groups; the actual native model family is not established, so no cross-family independence claim is made.

| Review | Fixed scope | Route | Verdict |
|---|---|---|---|
| hooks-r4-plan | Complete mandatory-command evidence and plan gate; R4 inventory verified | `magpie/group/expert` | PASS |
| hooks-r4-review | Three-file rule-ID delta; remaining 30 files retain R3 implementation PASS | `magpie/group/smart-split` | PASS |
| hooks-r4-security | Three-file rule-ID delta; remaining 30 files retain R3 security PASS | `magpie/group/expert` | PASS |

## Evidence interpretation

Configuration saving does not establish adoption, eligibility or execution. The save result reports those separately; the controlled test fixtures alone establish execution in isolated tests. Already-admitted children may finish after concurrent revocation. Actual-start admission linearizes at the final synchronous validated-policy read, not atomically with an OS process spawn. No cancellation, replay, exactly-once, delivery/ACK, task-completion or uninterrupted format-upgrade guarantee is added.

This delivery is not production verification, deployment approval or Handoff closure. Local commit identity will be recorded in the delivery response; it cannot be embedded in the same commit without self-reference.

## Frozen implementation file inventory

These are the 33 R4 target files, relative to `packages/pi-chat-exchange/`. The final report itself is outside the fixed implementation target.

| File | SHA-256 |
|---|---|
| `docs/hooks.md` | `8832307c44d695363188534378d8fa7ed78afa21938348d9eb34dd170adc8a8d` |
| `docs/plans/2026-11-04-ce-hooks-contract-amendment-design.md` | `d8c72175a3472c569a04a5cebe1ebedcc301c0b0a00ee15095a3cb1e53644906` |
| `docs/plans/2026-11-04-ce-hooks-management-design.md` | `235d91fea4226109b1828a90a8fd9955de58728c65db1bac257bbe62aa277a69` |
| `docs/plans/2026-11-04-ce-hooks-management-implementation.md` | `a271b38c4d150b7dfe804c9f833c5601b826362589dc197cb64256c056ad8139` |
| `docs/reports/2026-11-04-ce-hooks-contract-design-review.md` | `dd4ca832887d92f10d9c53cc0a555d53f20c6bd50ffb5318a827297dba8eabc9` |
| `docs/reports/2026-11-04-ce-hooks-management-r2-review.md` | `b1e9c2761b0b0fa6fcccb618939eac7c24f6819405385bcec0732412d83cc039` |
| `pi-extension/index.ts` | `7f51dc37acb9670cfbf3f1572b4e17644e38b466775de0a40e200df04c830b2a` |
| `pi-extension/live-session-profile.ts` | `2e058700fb7746057520d9393a7308786d6797c3643cf555c5d6a7bcadcd3621` |
| `pi-extension/live-session-runtime.ts` | `2ff9b4a7343e7a622a7888634fc17f33186f5e75f47eb3352b7eb8010c6cb0a9` |
| `pi-extension/multi-session-runtime.ts` | `ade00234ccad24e504d738bfb02a3b41539f6359d24560dbe5b2b596afba1fa2` |
| `src/bin/mcp-stdio.ts` | `d1de324ae9a95b2a9b924e233861733cd71f5b3056f148e80b1d21cbcbe65620` |
| `src/host/mcp-binding-config.ts` | `8c077fe7d77d1f0e275c2efed04b8864a592ea2164ee82c14b0c10e260f318ed` |
| `src/tunnel/hooks-management-ui.ts` | `4c3236c9b10fbd63878f3deb9030ecbe32d78062bc31dbfa5fb8421a3bf5499b` |
| `src/tunnel/hooks-management.ts` | `ec8b8270b54528e70cb0dc71a743823a51004fe8a04db2b5cc36eedb48742038` |
| `src/tunnel/live-adoption-observation.ts` | `5225e9ea6d936682d572365d4145582c98867bc850c3b533c7ae40d8360b7442` |
| `src/tunnel/live-adoption-probe.ts` | `1a0701ecfeb9d961f191916cb0b0ad82577e68dbd00e16f8f24bc6ab00956fc0` |
| `src/tunnel/live-connection-status.ts` | `3414b79db0da0c4d8f08e12028542de5f3e172685d8767ac6f0107c09cef29d0` |
| `src/tunnel/live-mcp-composition.ts` | `78ab716a5a1599fac9a8d1f94cf58677094c126f1245796ad38953d17c193de7` |
| `src/tunnel/live-session-policy.ts` | `6e29c8205aa8fb9267724af0302e75387baaa2dbb58e3c59b1c451c768e79c60` |
| `test/endpoints/pi/extension-live-hooks-v2-real.test.ts` | `4cbc1932bb5f787c841ed021fab071fda47f065f3eb5a64825f06c8382ff0d71` |
| `test/endpoints/pi/hooks-v2-runtime.test.ts` | `d702d522bae35d63bbe5bc711f9f94a5d6477466835b7ace506b26afec1b5af7` |
| `test/endpoints/pi/live-hooks-v2-integration.test.ts` | `07433ad5bd82cfd6612062777d116f987e8fcc0c596795bc1ea9281cc5b5ecf8` |
| `test/host/mcp-binding-config-v2.test.ts` | `f962b6a0705a250cf51edeb3f011fbbf53d3f41a06bc2a729828870e181c8e29` |
| `test/tunnel/hooks-management-characterization.test.ts` | `e77bb09735f711b059809e0ec24aed9d869bc8b11aa84b09c341d5197076bbe1` |
| `test/tunnel/hooks-management-legacy.test.ts` | `b023b343573cde4101c7fe507712b25b5f0b287ee15f9b2422aa63a9e2fb7b2e` |
| `test/tunnel/hooks-management-ui.test.ts` | `fb15e94dc761a1ff7a4d33e57aa273126a0c1e33a5488fa95d5d4cbcbdfad947` |
| `test/tunnel/hooks-management.test.ts` | `1cc08a0d8739b44fa5622f90cceadd1c4203454da80fe881ca5d34ebf246b047` |
| `test/tunnel/live-adoption-probe.test.ts` | `e7b8be198d069ea44c05a4806a690e79892d6061d031481cac3fbb795ae45a50` |
| `test/tunnel/live-connection-status.test.ts` | `841dd00beeb87850b06a3a316d0fb95a70aa47655e458ca926515122f0553190` |
| `test/tunnel/live-mcp-hooks-v2-stdio.test.ts` | `6af79c373eac964051bf085655020151a911d4159a42636237d0810268778c58` |
| `test/tunnel/live-mcp-hooks-v2.test.ts` | `c01d8fb23878c0438ecb6943f08d66e294009b638554652848f87fb26ec34b96` |
| `test/tunnel/live-session-migration.test.ts` | `a00b30e0510571741cf149ee0d8ac4601969bb381c314afc4b11ed26f6d9dc67` |
| `test/tunnel/live-session-policy-v2.test.ts` | `e1af85ac8b299c98cbd7abc34f39f31bb8fb1a0c1f1e74c436649558a6a78a5b` |
