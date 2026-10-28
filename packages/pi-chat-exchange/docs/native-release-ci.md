# Native SQLite CI and release policy (repository only)

Middleware 0.1.0 / ABI 1 uses the checked-in Cargo.lock and bundled SQLite 3.54.1. This document describes workflow intent; a local test does not establish Hosted CI, OIDC signing or successful publication.

## Test layers and permissions

All four artifact targets build and run Native loading, scalar/BLOB/error/lifecycle/authorizer/defensive conformance. Only `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu` run the schema-v7 Store cross-driver test. macOS x64 and Linux arm64 are artifact targets only; their Store tests are not reported as compatible or accepted. The production Store allowlist is unchanged.

Build jobs have only contents read permission. A separate `attest` job runs only for manual dispatch on `zieglar/pi-packages` main after all builds succeed. It has contents read, attestations write and id-token write, but no release write permission. It checks each module's version, ABI, target, source commit buildId and SQLite version, aggregates SHA256SUMS and manifests, then uses the pinned official `actions/attest` action to generate build provenance for every actual binary and metadata/checksum file. The signed bundle is retained with that exact set. No PR trigger, pull_request_target or workflow_run can enter these privileged jobs.

Release is a separate environment-gated job requiring `publish=true`, the public repository and main. It has contents write but no OIDC signing permission. It downloads only the attested set from the same run, verifies every subject's bundle against repository, workflow, main ref and exact source SHA using `gh attestation verify`, and checks SHA256SUMS before writing a tag or Release. A checksum list is itself an attested subject, so replacing it is not accepted merely because its content matches substituted assets.

## Version immutability

`scripts/native-release.mjs` checks both the tag and Release endpoints. Only a valid HTTP404 means absent; permission/transport/parse failures refuse publication. An existing tag or Release, including a draft, refuses without writes. The helper requires repository immutable releases to be enabled, atomically creates a new tag ref at the exact build SHA, creates a draft with all verified assets using `--verify-tag`, then publishes it. It never force-updates a tag, clobbers an asset, deletes a failed draft or retries an uncertain operation. An interrupted attempt may retain a tag or draft and requires manual review; rerunning refuses that version.

Workflow serialization is supplemental, not a repository protection mechanism. The code cannot enable or prove a tag ruleset. Administrators must configure and verify:

- Immutable releases for the public repository. Publishing the draft must lock the tag and asset set. The release helper refuses when this setting is disabled or unreadable.
- An active tag ruleset for `ce-sqlite-v*` that prohibits updates/deletions and limits creation/bypass to the approved release path. Ensure the intended token can create a fresh tag without permission to move it.
- Protection/review for main and the `native-sqlite-release` environment, including deployment branch restrictions and required reviewers. Merely naming an environment does not establish these settings.
- Appropriate GitHub plan/visibility and permissions for Artifact Attestations.

On 2026-10-28 the read-only public repository API reported immutable releases disabled (`enabled=false`, `enforced_by_owner=false`) and no rulesets. No administrator configuration was changed. These are external prerequisites to release, not a reason to skip local workflow fixes.

## Next authorized verification

1. Push only after explicit authorization, record the exact remote commit, then dispatch with publish=false. Verify four Hosted build results, Native conformance and the supported Store test subset, plus the official attestation identities/digests.
2. Independently verify each downloaded file: `gh attestation verify FILE --repo zieglar/pi-packages --signer-workflow zieglar/pi-packages/.github/workflows/native-release.yml --source-ref refs/heads/main --source-digest COMMIT_SHA`. Verify the checksum manifest as well as the binaries. Local mocked-gh tests establish refusal/control flow only, not signature authenticity.
3. Before separately authorized publication, confirm repository settings and version absence. Publish the exact attested set, validate the immutable Release and tag SHA, then test actual GitHub downloads in an isolated cache with independently anchored pins and offline loading.
4. Production compatibility hashes remain null until a separately reviewed trust-pin update. Neither a Release checksum downloaded alongside a binary nor a successful local build authorizes trusting new bytes.

Local bounded checks: `node --test scripts/test/native-release.check.mjs`, `node scripts/check-native.mjs`, YAML/shell static validation. No full storage matrix or Rust rebuild is needed for this CI-only delta. The release helper and this repository-only policy are excluded from the npm payload by the existing package file list.
