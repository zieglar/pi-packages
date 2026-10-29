# HANDOFF-PI-CE-NPM-OIDC-PUBLISH-01

Date: 2026-10-30 local / 2026-10-29 UTC. Verdict: **BLOCKED before publication**. Authorized version is exclusively @zieglar/pi-chat-exchange@0.2.1. Release preparation and PX-0018 push completed, but the new fixed-SHA Hosted CI failed a Desktop plugin version-equality check. The user explicitly required publication to stop on Hosted CI failure. No publish workflow was dispatched, no npm publish attempt occurred, and exact Registry 0.2.1 still returned HTTP404 after the failure.

## Baseline, Registry and OIDC preflight

Private starting HEAD main@31f28b12fe726cfd03cf590c2b87289f4bc3eb37; Public starting main/PX-0017 7e8795e8ff421fd557fcd28ae5db784e8b7bff95. Original untracked AGENTS.md/.herdr-web-ui/ were preserved. Authorized actual Public fetch confirmed remote main exactly at PX-0017 before development and again before push. Full repository/branch/worktree/remote/upstream/ahead-behind observations are in external baseline.json. No history rewriting, PR, extra branch or tag push occurred.

Real Registry packument reported versions 0.0.0-stage and 0.2.0, dist-tags latest=0.2.0. Both the complete version list and exact 0.2.1 endpoint confirmed absence, with HTTP404 from the Registry. Production npm preflight later repeated absence checks successfully. Existing 0.2.0 metadata and engine range were retained as historical evidence.

GitHub npm-release Environment was read through its API: main-only policy64744273, no reviewer rule, can_admins_bypass=false. Existing npm-publish.yml is workflow_dispatch-only, main/repository-restricted, publish=true, exact expectedSha==GITHUB_SHA, contents:read/id-token:write, persist-credentials:false and the npm-release Environment. It was unchanged. npm-release.mjs rejects NPM_TOKEN, validates package identity/repository/pins/version absence, publishes the tarball produced by its same-call preflight, attempts once, and has no token fallback/retry path. No personal npm login or token was inspected or used.

Npm-side settings are not exposed in the public packument, and the tools had no logged-in npm browser profile. The operator explicitly confirmed matching GitHub ownerzieglar/repositorypi-packages/workflownpm-publish.yml/environmentnpm-release, direct publish allowed and status verified. This is recorded as operator settings-page evidence, not falsely described as an independent API read. Current official npm documentation was fetched directly after Context7 failed and the generic fetcher refused local proxy DNS; it requires npm>=11.5.1/Node>=22.14.0 and automatically generates provenance for public GitHub OIDC publication. Hosted Node24.21.0/npm11.19.0 meets the prerequisite. No OIDC token was requested because the CI gate failed first.

## Authorized release preparation

Private fixed candidate: **59a60bce28f6b61861302fb05f98018ff1d2dfdc**.

The existing Changesets workflow consumed .changeset/ce-e2b-ack-mcp.md from base0.2.0 and produced exact0.2.1; no other package version or lockfile changed. The generated repeated ACK text was reconciled into bilingual0.2.1 release notes, preserving the historical0.2.0 chapters. Changesets status after consumption reported changed files with no pending changeset at the pre-commit state; this is retained rather than represented as a green validation. No second version operation or automatic0.2.2 increment occurred.

Changes include target package.json version, MCP SERVER_VERSION metadata, exact-version real-Host/loopback fixtures and release assertion, and bounded README/changelog/Native management/runtime evidence updates. Current docs use version-scoped0.2.1 facts, manual Native installation/restart and no fallback; no premature npm/OIDC provenance success claim. Native Release, ABI1, sourcea8386aafd657c84825b2905847f34a43d5b91e1e, four production pins, binaries, runtime/Store/Tunnel/Delivery/Recovery implementation and dependency versions are unchanged.

One targeted read-only reviewer inspected fixed59a60bce and the existing publication/packaging path, returning PASS with limitations. Independent context only; magpie/group/smart-split low, underlying family unknown. Reviewer correctly required same Public SHA CI and Registry/provenance postchecks and noted absence of every possible credential-config sanitization; the clean hosted workflow has no token secret/configuration and no local publish was authorized. Static PASS does not override failed CI or prove a successful publication.

## Tests and final local artifact

| Check | Observed result |
|---|---|
| Version assertion before update | RED, expected0.2.1/received0.2.0 |
| Release preparation/packaging | 27/27 |
| Native production pin/readiness/default/Tunnel gate | 27/27 using actual published module |
| Workflow release/security suites | 73/73 |
| Workspace, build, typecheck, contract/Native check | Exit0 |
| Loopback exact-version Registry fixture | 1/1 |
| Bilingual docs | No broken local links or missing pairs |
| Formal production Registry/tarball preflight | Success for exact0.2.1, 88 files |
| Public fixed-source independent install/build/preflight | Success; resulting tarball byte-identical to local smoke artifact |
| Real installed Pi1.3.0 on Node22.19.0 using final tarball | Install/load/first-run/persistence PASS; cloudNOT_VERIFIED |
| Export Ledger pre-push | 52 events/18 exports, Git provenance PASS; negative5/5 |

Final local/public candidate tarball SHA-256: **786ba02ebb4e20631bcbfba571a10d1d7ee2b3215118c1259778eedbf36c406f**. It contains88 files including English README/LICENSE/prebuilt runtime/Pi extension, name@zieglar/pi-chat-exchange/version0.2.1/engine>=22.19.0. No .node binary, Private evidence/Skills/Ledger, detailed docs/Chinese docs, checked credentials or machine paths. Full file inventory and SHA512 are in candidate-tarball.json. GitHub keeps bilingual documents.

Packaging uses the same buildPackageArtifact/preflight implementation as publication. An archive of exact Public candidate was installed/built and packed independently; all88 member bytes and entire tgz bytes matched. The actual Pi smoke used those bytes, with verified Native production cache copied to a private HOME and no selection override. Raw Host evidence: /private/tmp/ce-distribution-fix/installed-host-wa5brfs3. No real Tunnel or cloud connection, no production installation or Store change.

These targeted successes were insufficient to catch a separate Desktop manifest version mismatch. Prior Node22 full-suite22 attributed failures and prior local test timeouts remain historical limits; no whole-suite local rerun was claimed in this handoff. The new full Hosted candidate result below is authoritative and failed.

## PX-0018 export and normal push

Public **PX-0018 08a0394928b454b7dea2c8d96c95219636e858f3**, direct parent **PX-0017 7e8795e8ff421fd557fcd28ae5db784e8b7bff95**. Fourteen scoped CE release metadata/docs/test-fixture blobs match accepted Private59a60bce exactly. Private Changeset deletion/configuration, audit, Skills and governance are excluded. Only target package version changed; frozen Native pin blob and npm workflow blob match the parent.

After re-fetch proved exact parent, normal fast-forward pushed only refs/heads/main with push.followTags=false. Post-push ls-remote and fetch confirmed exact PX-0018 and no drift. Public checkout remains clean; original Public verify checkout unchanged. Ledger appended PX-0018 PENDING_EXPORT, COMMITTED and PUSHED facts only:53 events/18 exports. No CI_VERIFIED, PUBLISHED or invented Ledger status was added. Actual attempted/published/verified release facts are recorded here, outside the export-only Ledger schema.

## Hosted CI failure and minimal reproduction

Workflow **CI**, run **40919060800**, https://github.com/zieglar/pi-packages/actions/runs/40919060800 . Eventpush, branchmain, exact head **08a0394928b454b7dea2c8d96c95219636e858f3**, attempt1, completed/failure.

- validate: Node24.21.0, Ubuntu24.04x64. Workspace/build/typecheck/check passed; Test failed, exit1. **2855 passed / 1 failed / 24 skipped / 2880 total**; 173 passed files,1 failed,2 zero-registration skipped files. Diff hygiene did not run after failure.
- native(22.19.0): Ubuntu24.04x64, **227/227 passed**, no skips/failures.
- native(24.22.2): Ubuntu24.04x64, **227/227 passed**, no skips/failures.

The first failed case is `test/plugin/local-plugin-package.test.ts > ChatGPT Desktop local plugin source package > declares a portable plugin and a local stdio MCP server`, line34. Expected manifest version0.2.1, actual0.2.0. Test reads candidate package.json dynamically and compares plugin/pi-chat-exchange/plugin.json. That Desktop source manifest was not synchronized by the release preparation, so this is a deterministic release metadata consistency regression, not an already-attributed Node22 compatibility failure or Native defect. The parent omitted the metadata sync; neither targeted packaging tests nor static review exposed it before Hosted CI.

An unchanged one-test local reproduction confirmed the same mismatch in157ms, with original output retained. Smallest suggested repair: set only plugin/pi-chat-exchange/plugin.json version to0.2.1, retain the existing equality assertion, verify any other same-version release metadata, then fixed-version review/export/CI under fresh authorization. Do not relax/remove the assertion or infer a pass by retrying. **No repair or rerun of Hosted CI was performed**, because this handoff explicitly requires stopping publication on candidate CI failure rather than expanding scope.

## Publication reconciliation and final state

Publish workflow run list for exact PX-0018/npm-publish.yml is empty. No workflow_dispatch publish=true request, npm publish subprocess or token publish happened. Registry exact0.2.1 returned HTTP404 again after the failed candidate CI. Therefore **Published:NO**, **Registry artifact/provenance verification:NOT_APPLICABLE**, **Registry install smoke:NOT_RUN**. Local artifact smoke is not substituted for a real Registry installation.

Implemented:0.2.1 release preparation, with Desktop version sync defect outstanding. Tested: targeted gates/real local artifact Host passed; required whole candidate CI failed. Dogfooded: isolated tarball real Pi only, not production/cloud. Published:NO. Verified: source mapping/local artifact/Native tests verified, npm release not verified. Blocked: required exact-SHA Hosted CI failure.

No npm version or external fact is rolled back or reclassified; there simply was no publish attempt. No automated retry, alternate version, unpublish/deprecate, tag/Release mutation, Trusted Publisher change, PR or deployment occurred. Audit and factual Ledger closure only are authorized after this blocker. Stop pending a separately authorized minimum metadata repair and renewed release gate;0.2.1 remains the sole authorized version and must be rechecked for Registry absence before any future attempt.

Evidence directory: `/Users/zieglar/Code/Pi-Project-Evidence/chat-exchange/npm-oidc-publish-01/`. Key records: registry-preflight-packument.json/version-absence; operator identity confirmation; environment API; candidate-tarball.json; public-private-artifact-identity.json; candidate-installed-host.json; review transcript; PX18 source/push/provenance; candidate-ci-final.json; first raw CI logs; plugin-version-minimal-repro.json; registry-after-ci-failure.json; publish-runs-none.json. First failures, including version RED, are preserved. No secrets were inspected or output.
