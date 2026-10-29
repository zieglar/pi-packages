[English](native-release-ci.md) | [简体中文](native-release-ci.zh-CN.md)

# Native SQLite CI and release procedure (repository only)

Middleware 0.1.0 / ABI 1 uses the checked-in Cargo.lock and bundled SQLite 3.54.1. The workflow and release helper define the procedure below; local tests alone do not establish Hosted CI, OIDC signing or successful publication.

## Verified release boundary

The immutable `ce-sqlite-v0.1.0` release (ABI 1, SQLite 3.54.1) was published from source `a8386aafd657c84825b2905847f34a43d5b91e1e`. Historical verification downloaded the assets and checked their attestations. Hosted Native Store integration covered macOS arm64 and Linux x64; macOS x64 and Linux arm64 have artifact/conformance evidence only. These results do not establish broad cloud or end-to-end compatibility.

Production hashes in `src/storage/native-compat.ts` remain null. `src/storage/sqlite-driver-selection.ts` defaults to `node-sqlite` and never falls back after a Native failure; `src/storage/native-artifact.ts` refuses unpinned assets. Publication does not enable Native by default.

The separate npm workflow remains local and unpushed, with no hosted OIDC proof. The owner reports that the publisher connection is configured; this is not a hosted publication result. npm `@zieglar/pi-chat-exchange@0.2.0` is already published independently of this Native release.

## Test layers and permissions

All four artifact targets build and run Native loading, scalar/BLOB/error/lifecycle/authorizer/defensive conformance. Only `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu` run the schema-v7 Store cross-driver test. macOS x64 and Linux arm64 are artifact targets only; their Store tests are not reported as compatible or accepted. The production Store allowlist is unchanged.

Build jobs have only contents read permission. A separate `attest` job runs only for manual dispatch on `zieglar/pi-packages` main after all builds succeed. It has contents read, attestations write and id-token write, but no release write permission. It checks each module's version, ABI, target, source commit buildId and SQLite version, aggregates SHA256SUMS and manifests, then uses the pinned official `actions/attest` action to generate build provenance for every actual binary and metadata/checksum file. The signed bundle is retained with that exact set. No PR trigger, pull_request_target or workflow_run can enter these privileged jobs.

Release is a separate environment-gated job requiring `publish=true`, the public repository and main. It has contents write but no OIDC signing permission. It downloads only the attested set from the same run, verifies every subject's bundle against repository, workflow, main ref and exact source SHA using `gh attestation verify`, and checks SHA256SUMS before writing a tag or Release. A checksum list is itself an attested subject, so replacing it is not accepted merely because its content matches substituted assets. Attestation verification with `--bundle` is performed offline against the run's own signed bundle and needs no credential.

## Credentials used at release

Two credentials are used and never mixed:

- The **publish credential** (`GH_TOKEN`, the workflow `GITHUB_TOKEN` with `contents: write`) performs every version-specific read and every write: tag existence, release existence, environment and branch-policy reads, tag creation, draft creation and publication.
- The **administration credential** (`CE_RELEASE_ADMIN_TOKEN`) is used only for repository-control reads that need repository administration read: `GET /repos/{owner}/{repo}/immutable-releases` and the tag ruleset endpoints (`GET .../rulesets` and `GET .../rulesets/{id}`). It is never used for any write and never for version-specific reads.

`GET /repos/{owner}/{repo}/immutable-releases` returns 401 without a credential and 403 for a `contents: write` token, which is why a `contents: write` workflow token alone cannot perform that precondition. Tag ruleset details expose their bypass protection fields only in authenticated responses, so they are read with the administration credential as well. The environment object and its deployment branch policies are ordinary repository reads and keep using the publish credential.

The administration credential is provisioned by the repository owner as a fine-grained personal access token limited to this repository with **Administration: Read-only** (and implicit Metadata read). It is stored as an **environment secret** on `native-sqlite-release`, so only the release job that declares that environment can read it; build and attestation jobs never receive it. If the secret is missing, the release refuses before any API call. The administration credential is read-only for repository administration and cannot create tags, releases or assets.

The publish credential is never the administration credential: if both values are identical, the release refuses, because that would silently turn a read-only precondition read into an elevated publish.

## Automated release gate (no human approval click)

The `native-sqlite-release` environment has **no required reviewer**. There is no human approval event and no independent two-person review of a release. Authorization is the explicit `workflow_dispatch` by a write-capable actor on `main`, plus the mandatory checks that run inside the protected release job:

1. The operator must state the exact commit SHA to publish (`publish_sha`). The release refuses if it is absent, malformed, or not equal to the dispatched commit SHA, so an unrelated or newer main head can never be published by accident.
2. Immutable releases must be enabled (read live from the repository administration endpoint).
3. An active `ce-sqlite-v*` tag ruleset must exist that blocks tag updates and deletions and has no bypass actors and no bypass for the caller.
4. The release environment must have `can_admins_bypass=false` and must restrict deployments to `main` only.
5. The version's tag and Release must be absent; only a genuine HTTP 404 proves absence.
6. The release set must be exactly the fixed eight-file inventory, every SHA256SUMS entry must match the bytes on disk, and all seven attestation subjects must verify against the repository, signer workflow, source ref and exact source SHA.

If any of these fails, no tag or Release is created.

## Version immutability

`scripts/native-release.mjs` checks both the tag and Release endpoints. Only a valid HTTP404 means absent; permission/transport/parse failures refuse publication. An existing tag or Release, including a draft, refuses without writes. The helper requires repository immutable releases to be enabled, atomically creates a new tag ref at the exact build SHA, creates a draft with all verified assets using `--verify-tag`, then publishes it. It never force-updates a tag, clobbers an asset, deletes a failed draft or retries an uncertain operation. An interrupted attempt may retain a tag or draft and requires manual review; rerunning refuses that version.

Workflow serialization is supplemental, not a repository protection mechanism. The code cannot enable or prove a tag ruleset. Administrators must configure and verify:

- Immutable releases for the public repository. Publishing the draft must lock the tag and asset set. The release helper refuses when this setting is disabled or unreadable.
- An active tag ruleset for `ce-sqlite-v*` that prohibits updates/deletions and limits creation/bypass to the approved release path. Ensure the intended token can create a fresh tag without permission to move it.
- Protection/review for main and the `native-sqlite-release` environment, including deployment branch restrictions. The recorded automated release gate has no required reviewer; configure protection consistently with that gate. Merely naming an environment does not establish these settings.
- Appropriate GitHub plan/visibility and permissions for Artifact Attestations.

Historical pre-release observation: on 2026-10-28 the read-only public repository API reported immutable releases disabled (`enabled=false`, `enforced_by_owner=false`) and no rulesets. No administrator configuration was changed. That observation predates the verified release above and does not describe current repository settings. These settings remain external prerequisites for future releases.

## Procedure for a future authorized release

1. Push only after explicit authorization, record the exact remote commit, then dispatch with publish=false. Verify four Hosted build results, Native conformance and the supported Store test subset, plus the official attestation identities/digests.
2. Independently verify each downloaded file: `gh attestation verify FILE --repo zieglar/pi-packages --signer-workflow zieglar/pi-packages/.github/workflows/native-release.yml --source-ref refs/heads/main --source-digest COMMIT_SHA`. Verify the checksum manifest as well as the binaries. Local mocked-gh tests establish refusal/control flow only, not signature authenticity.
3. Before separately authorized publication, confirm repository settings and version absence. Publish the exact attested set, validate the immutable Release and tag SHA, then test actual GitHub downloads in an isolated cache with independently anchored pins and offline loading.
4. Production compatibility hashes remain null until a separately reviewed trust-pin update. Neither a Release checksum downloaded alongside a binary nor a successful local build authorizes trusting new bytes.

Local bounded checks: `node --test scripts/test/native-release.check.mjs scripts/test/native-release.auth.test.mjs`, `node scripts/check-native.mjs`, YAML/shell static validation. No full storage matrix or Rust rebuild is needed for this CI-only delta. The release helper and this repository-only policy are excluded from the npm payload by the existing package file list.
