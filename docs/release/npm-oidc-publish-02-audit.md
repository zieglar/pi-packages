# HANDOFF-PI-CE-NPM-OIDC-PUBLISH-02

Date: 2026-10-29 UTC / 2026-10-30 local. Verdict: **ACCEPT**. Exact version **@zieglar/pi-chat-exchange@0.2.1** was published once through the existing GitHub Actions OIDC Trusted Publisher. PX-0019 full Hosted CI passed before dispatch. Registry identity, minimal tarball bytes/integrity, cryptographic signatures/provenance and an installation from the actual public Registry were subsequently verified. No next-version publication is authorized or attempted.

## Baseline and bounded repair

Private main started at **f3a92f4642d6f66c13abac8eaaf1ed59e9ff9f74**. Public main/PX-0018 and the export checkout started at **08a0394928b454b7dea2c8d96c95219636e858f3**. Actual fetch confirmed Public origin/main at that SHA. The export branch remains export/ce-native-default-01, without configured upstream; explicit comparison against fetched origin/main was0/0 initially. Private origin/main comparison was158 ahead/0 behind. Original Public verify/ce-public-ci-03 remains86e0efa21645f429aa014b4d5fe2ac68d95434ad, upstream origin/verify/ce-public-ci-03,0/0 and clean. Repository roots, all worktrees, remotes, statuses, branches and upstream failures for the intentionally untracked export branch are retained in baseline.json. User untracked AGENTS.md and .herdr-web-ui/ were preserved.

Real Registry packument and exact-version endpoint were reread before changing files: latest0.2.0, versions0.0.0-stage/0.2.0,0.2.1 absent with HTTP404. Previous round failure/RED and first Hosted failure remain in npm-oidc-publish-01 evidence and its committed audit; they were not erased.

Private fix **adf51b2ba3540f48b050ae7bdda39c63b1301b52**, directly following f3a92f4, changes only `packages/pi-chat-exchange/plugin/pi-chat-exchange/plugin.json:4`: version0.2.0 to0.2.1. Tests, timeout, assertions, npm metadata, MCP metadata, installation fixtures, workflows, pins, Native implementation and other packages were unchanged. Npm/MCP/Desktop/installed-Host/loopback fixture version checks all resolved0.2.1. No dependency or lockfile changed.

## Regression, artifact and review

Original unchanged `test/plugin/local-plugin-package.test.ts` was run before repair:1 failed/2 passed/4 existing conditional skips. Failure was expected0.2.1/received0.2.0. After repair:3 passed/4 conditional skips/0 failures. The four opt-in Desktop artifact cases were not claimed as executed. Release preparation/distribution suites27/27 passed; workspace validator passed for two Private packages; target build passed. Existing test remains dynamically tied to packageManifest.version.

Formal `scripts/npm-release.mjs preflight` at the fixed Private SHA passed against the real Registry, validating the Native production manifest and all four trust pins and creating88-file0.2.1 tarball. SHA-256:

`786ba02ebb4e20631bcbfba571a10d1d7ee2b3215118c1259778eedbf36c406f`

The tarball is byte-identical to the previous round artifact, so its real Pi1.3.0/Node22.19.0 isolated smoke remains applicable, as explicitly allowed by this handoff. The sole modified Desktop directory is excluded by the unchanged npm whitelist; exact Public source inputs for the payload remain identical to PX-0018. No extra npm payload or Native binary was introduced. Registry download later independently reproduced the same bytes.

Fixed candidate review: **PASS**, reviewer npm022-review-2, standalone context, magpie/group/smart-split, low (supported budget). Underlying family is unknown, with no cross-family claim. It independently inspected the exact base/source diff, preserved test/version equality, unchanged workflow/pins/pack boundaries, and absence of private content. It did not run tests or independently revalidate the parent's tarball; these limits are retained. First reviewer anthropic/claude-sonnet-4-6 failed before producing a result because its account lacked extra usage. A medium request to the routed replacement was rejected by compatibility validation before launch; low was selected and succeeded. No failed reviewer was represented as PASS.

## PX-0019, privacy and normal push

Public **PX-0019 c7e2f0f756cd1868f175bde8743cef9920fbc6b8**, direct parent **PX-0018 08a0394928b454b7dea2c8d96c95219636e858f3**. Exactly1 exported blob equals fixed Private adf51b2; the commit carries Export-ID: PX-0019. Private history, Skills, changesets, governance, audit and Ledger are excluded. Per-path sourceCommit/blob/targetBaseBlob/contentDigest are in the Ledger and external PX19 records.

Ledger schema, transitions, digests and Git provenance passed at55 events/19 exports before push; five existing positive/negative fixtures passed5/5. Public single-path delta privacy scan found no machine/private credential markers; workflow and Native pin blobs equal the Public parent. The full npm inventory stayed88 entries and excludes .node/Private documents/full bilingual docs/Skills. Only the version string is new Public content.

After another actual fetch confirmed remote main still exactly PX-0018, normal fast-forward pushed only `c7e2f0f756cd1868f175bde8743cef9920fbc6b8:refs/heads/main` with push.followTags=false. Post-push ls-remote and fetch confirmed remote/local target/origin/main exactPX-0019 and0/0. No force, extra tag/ref/Release, history reconciliation, PR or deployment occurred.

## Exact-SHA Hosted CI hard gate

**CI run40925049158**, attempt1, eventpush, main, exact head **c7e2f0f756cd1868f175bde8743cef9920fbc6b8**, completed/success.

https://github.com/zieglar/pi-packages/actions/runs/40925049158

| Job | Observed result |
|---|---|
| validate123628197573 | SUCCESS; workspace,build,typecheck,check,test,diff hygiene all actually succeeded |
| validate tests | 2856 passed/24 existing skipped/0 failed;174 passed files/2 skipped files |
| native(22.19.0)123628197623 | SUCCESS;227/227,15 files,no skips/failures |
| native(24.22.2)123628197601 | SUCCESS;227/227,15 files,no skips/failures |

Ubuntu24.04x64 Native jobs retain actual published Rust asset/checksum/pins/attestation qualification, not explicit Node compatibility fallback. Original plugin mismatch no longer failed. Raw first-attempt job logs and authoritative exact workflow/event/branch/SHA JSON were saved. No CI rerun was issued. Bounded watcher timeouts were followed by authoritative queries and not classified as failure. First gh log retrieval required its explicit terminal-escape output option, after which logs were retained successfully.

Ledger appended only existing states PENDING_EXPORT/COMMITTED/PUSHED/CI_VERIFIED for PX-0019. Final **57 append-only events/19 exports**, Git provenance/schema/transitions/content digests PASS. Existing53-event byte prefix is unchanged. Publication facts live in this audit, not an invented export status.

## Final gate and one publication

Immediately before dispatch, remote main was reread and equaled the successful candidate; Registry0.2.1 exact endpoint stillHTTP404. Workflow blob78b077827caa5884669908aaf74b11641270e41a and GitHub npm-release Environment/branch policy were reread with no drift. Environment ID25648131350, main-only policy64744273, no reviewer bypass/admin bypass. Same trusted identity ownerzieglar/repositorypi-packages/workflownpm-publish.yml/environmentnpm-release had been operator-confirmed verified/direct-publish-allowed in round01; this handoff carried that authorization forward without changing identity or permissions. The post-publication signed certificate independently verifies actual identity.

Final tarball checksum/name/version, fixed review, full CI and no prior candidate publish runs passed. Single dispatch recorded an external intent marker first and issued exactly:

- workflow npm-publish.yml, refmain
- publish=true
- publish_sha=c7e2f0f756cd1868f175bde8743cef9920fbc6b8

**npm Trusted Publish run40925828108**, attempt1, workflow_dispatch/main/exactPX19, completed/success; publish job123630935515.

https://github.com/zieglar/pi-packages/actions/runs/40925828108

Checkout exactSHA, pinned Node24.21.0, pnpm12.9.1, frozen dependency install with scripts disabled, contract/build/typecheck,73/73 release checks, formal88-file preflight and `Publish once using OIDC trusted publishing` all succeeded. Production path called existing npm-release.mjs publish, which reruns preflight and sends that validated tgz to a single npm publish. Log at2026-10-29T17:55:34.067Z confirms one completion. Registry records npm11.19.0/Node24.21.0. Successful helper captures npm subprocess output rather than printing it, so no invented Hosted tarball hash is claimed; actual Registry bytes provide independent artifact proof.

Exactly one publish workflow run exists for the candidate. No local/manual publish, npm-token fallback, npm login/config credential inspection, identity modification, separate dist-tag command or second publication occurred.

## Registry and provenance verification

Immediate post-success exact-version queries returned404 and packument latest0.2.0. Reconciliation was strictly read-only and retained each first observation; no retry of publication occurred. Canonical path/cache-bypassed/isolated npm reads also initially returned404. Later tarball HEAD/GET, exact-version and attestation endpoints returned200. Registry version time is **2026-10-29T17:57:42.543Z**; latest became0.2.1. Installation-format packument visibility lag caused a first ETARGET in the separate signature-check setup; once both full and install-format metadata exposed0.2.1, a fresh isolated install succeeded. These are preserved propagation observations, not hidden or converted into a failed publication.

Registry name@zieglar/pi-chat-exchange/version0.2.1, latest0.2.1. Packument difference from baseline contains exactly one new version0.2.1. Existing workflow only targets this one package; no other package publish command occurred.

Registry tarball:

`https://registry.npmjs.org/@zieglar/pi-chat-exchange/-/pi-chat-exchange-0.2.1.tgz`

| Identity | Verified value |
|---|---|
| SHA-256 | 786ba02ebb4e20631bcbfba571a10d1d7ee2b3215118c1259778eedbf36c406f |
| Registry SHA-1 | bae37e962c9652b5f6f7175001fcd13680561da1 |
| Registry integrity | sha512-jCmkBuv7OuwdVEg1hrGURiYyLn6aN40rxXt7+SYam/+HZFct/3yiRTu9aqrQRTrVfL5o4AOdLFnCrqcPo9WdfQ== |
| Files | 88; byte-identical entire tgz to tested formal candidate |
| Engine | >=22.19.0 |
| Publisher | GitHub Actions; npm-oidc-no-reply@github.com; trustedPublishergithub config34d4eb31-fc08-426c-a11b-42e7f551c159 |

Registry SHA512/SHA1 were recomputed over actual downloaded bytes and match dist metadata. Registry fileCount88/unpackedSize1074486 match the minimal artifact. Neither Native trust assets nor new lifecycle hooks enter the payload.

Actual Registry endpoint provides npm publish attestation and SLSA v1 provenance. Both subject SHA512 match the actual tgz. Provenance identifies repositoryhttps://github.com/zieglar/pi-packages, workflow.github/workflows/npm-publish.yml, refs/heads/main, workflow_dispatch, exact commitc7e2f0f756cd1868f175bde8743cef9920fbc6b8, GitHub-hosted builder and invocationhttps://github.com/zieglar/pi-packages/actions/runs/40925828108/attempts/1.

Signed Fulcio certificate has SANhttps://github.com/zieglar/pi-packages/.github/workflows/npm-publish.yml@refs/heads/main, issuerhttps://token.actions.githubusercontent.com, matching source/build SHA, run, public repository and explicit environmentnpm-release (OIDs1.3.6.1.4.1.57264.1.23/.24). Cert rendering is semantic evidence; cryptographic verification additionally used **npm11.19.0 audit signatures --json --include-attestations**, exit0, invalid[]/missing[], target@zieglar/pi-chat-exchange0.2.1 in verified[] with both bundles. Raw bundles/certificate/decoded statements/verifier output are retained. Initial audit against a lock-only tree found no supported installed dependencies; a real isolated installed tree was then used successfully. No authentication secrets were needed.

## Real Registry installation smoke

A diagnostic wrapper in the external evidence directory reused the existing real-Pi harness without changing repository tests. It replaces only non-managed install source (local tgz to exactRegistry name@0.2.1), asserts actual Registry URL/integrity in the resulting package lock, and labels INSTALL_ROUTE=public-npm-registry. It retains all installed-file byte checks against the independently downloaded verified Registry archive, real Host/TUI tests, runtime isolation, module-origin and persistence checks. This is an actual npm Registry installation, not the loopback fixture or another local tarball install.

Real **Pi1.3.0/Node22.19.0** evidence root `/private/tmp/ce-distribution-fix/installed-host-go8esp2j`:

- PACKAGE_INSTALL=PASS; REAL_HOST_LOAD=PASS; FIRST_RUN=PASS; errors[].
- Registry resolved URL/integrity match verified dist metadata;88 installed payload files equal Registry tarball bytes.
- Production Native-default runtime admission passed using copied verified production cache in an isolated HOME, no driver override or automatic download/repair.
- Offline Host runtime denied developer tree, staged archive and network;9299 filesystem resolutions, outsideCount0.
- Durable profile/policy/mutex/Store checks all exit0. Synthetic credentials/routes only; real cloud/Tunnel client never executed.
- Guardian outcome retained; native package remove/reinstall was not requested. CLOUD_TRANSPORT=NOT_VERIFIED remains explicit.

## Closure and limits

Implemented: sole authorized Desktop version metadata sync. Tested: original RED/GREEN, release/pack27/27, workspace/build, reviewPASS, exact Public fullCI success, hosted release73/73. Dogfooded: isolated actual Registry installation on Pi1.3/Node22.19. Published:YES, exactly0.2.1 through Actions OIDC once. Verified:YES, Registry bytes/integrity/cryptographic provenance/identity/real Registry Host smoke. Blockers:NONE for this handoff.

No claim of exhaustive Node/platform coverage, Linuxarm64 Store support, WSL2, cloud transport, physical power loss or unrun opt-in Desktop artifact cases is added. Existing qualified Native/Store scope and known historical explicit Node compatibility failures remain unchanged. No automatic install/update/fallback, trust pin, frozen Native/Store/Tunnel/Delivery/Recovery behavior or production state changed. This successful release does not erase the round01 metadata omission/failedCI.

Private closure commit contains only this audit and append-only Ledger events. Public main remains the publishedPX19. User untracked files and all other worktrees/original Public checkout remain preserved. Completion stops here: no next version, extra release, tag, PR, deployment, publisher change or outgoing message.

Evidence root: `/Users/zieglar/Code/Pi-Project-Evidence/chat-exchange/npm-oidc-publish-02/`. Key records: baseline, Registry preflight/propagation/formats/finalpackument, versionRED/GREEN/consistency, formal candidate/real Registry tarballs, fixed review/session, PX19 event/source records, Ledger/provenance/negative tests, privacy/push, exact CI JSON/rawlogs, finalpublishgate, dispatchintent/result, publishrun/logs, Registrydist, twoattestations, signedcertificate, decodedstatements, npm signatureverification, actual Registry Host result/lock/payload/runtime/persistence/moduleorigin, finalstate. First failures are retained. No copied secret/config credential bytes are included.
