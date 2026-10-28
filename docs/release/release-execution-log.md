# Public Release Execution Log (Private audit record)

Authoritative record of formal Public release execution attempts for the CE Native SQLite driver. Private repository only; never published to Public. Ledger status events in `public-export-ledger.jsonl` remain untouched by failed attempts, because that file's append-only status model has no state for a failed release and a fabricated RELEASED/VERIFIED event is not permitted.

## ATTEMPT-001 — ce-sqlite-v0.1.0, workflow dispatch publish=true

- Export-ID: PX-0005. Public Source SHA: `f68f9899e83e175bb8fcb9a85345fbf0f7fb0e3f`. Middleware 0.1.0 / ABI 1 / bundled SQLite 3.54.1.
- Dispatch: `gh workflow run native-release.yml --ref main -f publish=true`, once, from Public main. Run ID `40774757239`, https://github.com/zieglar/pi-packages/actions/runs/40774757239, run_number 3, event `workflow_dispatch`, actor and triggering actor `zieglar`, head_branch `main`, head_sha equal to the fixed Source SHA.
- Build jobs: four platform jobs (macOS arm64, macOS x64, Linux x64, Linux arm64) all **success**. Attestation job `123121534261` **success**.
- Publish job `123123705190`: initially `waiting` for the environment gate; deployment `7398269660` on environment `native-sqlite-release` (ID `25622680254`), reviewer `zieglar`, `wait_timer: 0`, `current_user_can_approve: true`.
- Human approval: performed by the repository owner `zieglar` in the GitHub interface, not by an administrator bypass and not by the assistant. Deployment status sequence recorded by GitHub: `waiting` → `waiting` → `queued` → `in_progress` → `failure` (creator `zieglar`, from 2026-10-28T21:52:39Z to 2026-10-28T22:00:12Z). The pending-approval list emptied when the job started.
- Result: **FAILED**, before any write.

### Failure

Failing step: `Refuse existing version and require repository immutability`, running `node packages/pi-chat-exchange/scripts/native-release.mjs check`.

```
GitHub API refused (403); no retry
##[error]Process completed with exit code 1.
```

Root cause: `checkRelease` reads `GET /repos/{owner}/{repo}/immutable-releases` as its immutability precondition. GitHub documents that endpoint as **requiring admin read access to the repository**. The publish job's token is the workflow `GITHUB_TOKEN` with `permissions: contents: write` only; a workflow token cannot be granted Administration read. The preflight's mocked-`gh` tests therefore exercised the control flow but never the real token's authorization, so the earlier G7 assessment did not cover this path. The script's fail-closed behaviour was correct — it refused on an unreadable precondition — but the precondition is not readable with the credential the workflow actually holds.

The failure occurred in the read-only preflight step, before any mutation: the tag was never created, no draft was created, no Release was created, and no asset was uploaded.

### Remote state after the failure (verified by read-only API and `git ls-remote`)

- `GET /repos/zieglar/pi-packages/tags` → `[]`.
- `GET /repos/zieglar/pi-packages/releases` → `[]`.
- `GET /repos/zieglar/pi-packages/git/ref/tags/ce-sqlite-v0.1.0` → 404 Not Found.
- `git ls-remote --tags origin` → empty.
- Only artifact of the attempt: the environment deployment record `7398269660` (status `failure`), which is the audit trail of the approval and the failed attempt.

### Build and proof produced by this attempt

The publish run rebuilt the four binaries and re-signed its own provenance. The produced assets were downloaded and verified read-only before approval and are byte-identical to the previously verified run `40763762249`:

| Asset | SHA-256 |
| --- | --- |
| `ce-sqlite-0.1.0-aarch64-apple-darwin.node` | `c0f1ae51e1f6d39af593c0e82ca8e92f1139f9b091e47a95040834259f51f1d1` |
| `ce-sqlite-0.1.0-aarch64-unknown-linux-gnu.node` | `174231fda4268497b4b4a675749dfa8972d27b5054b8c636d85950d1d8af8a19` |
| `ce-sqlite-0.1.0-x86_64-apple-darwin.node` | `991c5cb1c9e79f8474caad1df57851537c2204931fc2bac16249e1d9847a2c44` |
| `ce-sqlite-0.1.0-x86_64-unknown-linux-gnu.node` | `9ff9902b6b74a89a060eca91f06816ac5f2c9a112fed3f04bf29013e92dd65df` |
| `SHA256SUMS` | `0c3b515f63a78d7c280546c4317eb2fe8bcbe7e5112c9a4053a9fbb40dba9383` |
| `native-identities.json` | `897ae8debba02fd1ab98391bd950ce43c74c1aa57acb3fe89432ed7bed233978` |
| `native-manifest.json` | `ebee20b9d24e5c8eb6b2d6863bab46654462828d5c2b347eaf6a8e679c490607` |
| `provenance.jsonl` | `785db49202e3e3b9fd28853193cf5ab7604dce0ba23e8abb779241f497cc4917` |

Each `artifact-info.json` in this run reports middleware 0.1.0, ABI 1, SQLite 3.54.1 and `buildId = f68f9899e83e175bb8fcb9a85345fbf0f7fb0e3f`. All seven signed subjects verified with `gh attestation verify` against repository `zieglar/pi-packages`, signer workflow `zieglar/pi-packages/.github/workflows/native-release.yml`, source ref `refs/heads/main` and source digest `f68f9899…`.

### Disposition

No retry, no second dispatch, no tag recreation, no release deletion or rewrite, no asset overwrite, and no change to Immutable Releases, the tag ruleset, the environment, secrets or any GitHub administration setting. No production compatibility pin was updated and no npm publication occurred.

### Fix options (not implemented here; each needs separate authorization)

1. **Narrow scoped credential for the precondition (keeps fail-closed).** Provide the publish job a credential with Administration **read** on this repository only — for example a fine-grained PAT stored as a secret of the `native-sqlite-release` environment — and use it only for the `immutable-releases` read. The workflow `GITHUB_TOKEN` stays `contents: write`. This keeps the precondition inside the job and keeps fail-closed on an unreadable or disabled setting. Cost: a new secret and a small workflow change; the secret is only exposed to the protected environment job.
2. **Move the immutability precondition to the operator release gate.** Verify `immutable-releases` out of band with the owner credential, record the verified state and timestamp in the Private release audit, and let the job assert that precondition from that recorded, reviewable input instead of a live admin read. Cost: weakens the in-job live check; the job must then treat the recorded attestation as the authority.
3. **Bind immutability to an enforceable signal the workflow token can read.** For example require the release to be created as a draft and then published, and verify after publication that the Release reports an immutable/locked asset state through a non-admin endpoint. This needs confirmation that such a read exists for the repository's plan; it was not established in this attempt.

Option 1 is the only one that keeps the current fail-closed semantics unchanged and is recommended for the owner's decision.
