# Independent Release Audit Report — HANDOFF-PI-CE-RUST-NATIVE-RELEASE-EXEC-02

Status: **RELEASED_VERIFIED** (independent audit record, not a ledger status event).

This document is an independent audit report of a formal release. The append-only export ledger's schema (`PENDING_EXPORT → COMMITTED → PUSHED → CI_VERIFIED`) has no status for a published GitHub Release, so this fact is recorded here instead of by altering the schema or inventing a status.

## Release identity

- Repository: `zieglar/pi-packages`
- Public Source SHA: `a8386aafd657c84825b2905847f34a43d5b91e1e` (PX-0008)
- Middleware version: `0.1.0`, ABI `1`, bundled SQLite `3.54.1`
- Tag: `ce-sqlite-v0.1.0`
- Release ID: `427441708`
- Release URL: https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0
- Published at: `2026-10-29T03:46:23Z`
- `draft: false`, `prerelease: false`, **`immutable: true`**
- Tag ref `refs/tags/ce-sqlite-v0.1.0` object SHA == `a8386aafd657c84825b2905847f34a43d5b91e1e` (exact match).
- Tag ruleset `26078349` remains active, update and deletion blocked, `bypass_actors: []`, `current_user_can_bypass: never`, rules `update` and `deletion`.
- Governance exception: EXC-002 (automated release gate, no human approval click).

## Workflow execution

- Dispatch: exactly once, `gh workflow run native-release.yml --ref main -f publish=true -f publish_sha=a8386aafd657c84825b2905847f34a43d5b91e1e`.
- Run ID: `40813628775`
- Run URL: https://github.com/zieglar/pi-packages/actions/runs/40813628775
- `head_sha` == `a8386aafd657c84825b2905847f34a43d5b91e1e`
- Conclusion: **success**. No retry was performed.

Jobs:

| Job | ID | Result |
| --- | --- | --- |
| `aarch64-apple-darwin` | 123249498943 | success |
| `x86_64-apple-darwin` | 123249499083 | success |
| `aarch64-unknown-linux-gnu` | 123249499142 | success |
| `x86_64-unknown-linux-gnu` | 123249499239 | success |
| `Attest verified build outputs (no release credentials)` | 123250415224 | success |
| `Publish a new immutable version (explicit only)` | 123250501473 | **success** |

No environment human-approval wait occurred: the publish job proceeded automatically under EXC-002's automated gate. `GITHUB_TOKEN` was used for the publish operations, and `CE_RELEASE_ADMIN_TOKEN` was used only for the repository-control read-only checks (immutable releases and tag ruleset).

## Independent asset verification (downloaded from the published Release)

Assets were downloaded **from the published Release** (not from a CI artifact bundle) into a clean directory and verified:

- Exact eight-file inventory: `SHA256SUMS`, four `.node` binaries, `native-identities.json`, `native-manifest.json`, `provenance.jsonl`.
- `SHA256SUMS` lists exactly the four binaries; every digest matches the bytes on disk.
- All four `artifact-info` identities report middleware `0.1.0`, ABI `1`, SQLite `3.54.1`, and `buildId == a8386aafd657c84825b2905847f34a43d5b91e1e`.
- `native-manifest.json`: `abiVersion: 1`, `defaultVersion: 0.1.0`, `repository: zieglar/pi-packages`.
- All **seven attestation subjects** verified with `gh attestation verify --repo zieglar/pi-packages --bundle provenance.jsonl --source-digest a8386aafd657c84825b2905847f34a43d5b91e1e --source-ref refs/heads/main --signer-workflow zieglar/pi-packages/.github/workflows/native-release.yml`, all exit 0.

Asset digests (SHA-256, as verified from the published Release):

| Asset | SHA-256 |
| --- | --- |
| `ce-sqlite-0.1.0-aarch64-apple-darwin.node` | `b3b0102931f4fd50459e435cd0ac3ad68f61f9c00c0c14366eb03ab5f4b71db3` |
| `ce-sqlite-0.1.0-aarch64-unknown-linux-gnu.node` | `6186c334e362d283481182efd1c6e8eaa98702b76bd6c3e5e933d584263c99d2` |
| `ce-sqlite-0.1.0-x86_64-apple-darwin.node` | `53f036cca6b43a75f340c192dc67b070919904ad3590f5e63fa56a6d408e180b` |
| `ce-sqlite-0.1.0-x86_64-unknown-linux-gnu.node` | `d93db0cf84621495154ff98f3b293b615593967060050b38d9ceaee6871efaf7` |
| `SHA256SUMS` | `514946983297ea60ac90e34c61297c79e2449febb82977ee0dea899f8b45db1f` |
| `native-identities.json` | `77b4d54df4659af1b3a5957ab8a525ecdddb9f5b0a548d2f6fbcdcfaf2e0f596` |
| `native-manifest.json` | `e9e711789e302bda1812c505cf20eec80b52fd973410394f798b24895d4ecafb` |
| `provenance.jsonl` | `88746f70c3fc22adc22d93672efb97325ed96edd42d8b647a11eec5e67bd98b2` |

These match the digests independently recomputed during verification.

## Evidence files

- `release.json` — the published Release object (ID, draft=false, immutable=true, 8 assets).
- `tag-ref.json` — the tag ref proving the exact fixed SHA.
- `run-40813628775.json` — the publish run and job results.
- `release-assets-verification.json` — the seven attestation-verification results (all exit 0).
- `release-assets/` — the eight downloaded Release assets.

## Remaining risks

- The publish job has now run once and succeeded; the immutable Release exists. Any further publish of this version must refuse, because the tag and Release already exist.
- There is still no independent two-person review; the release was authorized by a single maintainer's explicit dispatch under EXC-002's automated gate.
- The in-workflow gate is code in the same repository and could be edited by a write-capable actor; server-side immutable releases and the tag ruleset still bound the outcome.
- macOS x64 and Linux arm64 remain artifact-only, with no Store integration coverage.
- Production compatibility hashes remain null until a separately reviewed trust-pin update; no production pin was changed in this handoff, and no npm publish was performed.

## Next action

Only if needed for downstream consumption: independently re-download this exact immutable Release's eight assets and re-verify the digests and all seven attestation subjects in a clean environment before any production trust-pin update. Do not dispatch another publish, do not move or delete the tag, and do not modify the Release or its assets.
