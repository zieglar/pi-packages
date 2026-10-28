# Release Approval Exceptions (Private audit record)

Authoritative record of accepted governance exceptions for Public releases of the CE Native SQLite driver. This file stays in the Private development repository and is never published to Public.

## EXC-001 — Release Approval Exception: Single Maintainer

- Status: **ACCEPTED** (recorded 2026-10-29, Private audit trail).
- Applies to: repository `zieglar/pi-packages`, GitHub Environment `native-sqlite-release` (ID `25622680254`), Native middleware `0.1.0` / ABI `1`, Export-ID `PX-0005`, Public Source SHA `f68f9899e83e175bb8fcb9a85345fbf0f7fb0e3f`.
- Decision: the release trigger and the required reviewer may be the same person.

Accepted risk and its boundaries:

1. The publisher and the approver may be the same individual. This repository has exactly one collaborator (`zieglar`, `admin`), so no independent second approver exists today.
2. The explicit GitHub Environment approval record is retained: the deployer must still record an approval in the environment before the `contents: write` publish job runs. The approval is auditable in the environment deployment history.
3. There is **no independent two-person review** of a release. A single maintainer both triggers and approves.
4. Scope: the first Public release of the Native SQLite driver under the single-maintainer operating model. This exception is not a blanket policy for later releases.
5. Reverting condition: as soon as a second trusted maintainer is added and can be registered as a required reviewer, `prevent_self_review` must be set back to `true` for this environment and this exception retired.
6. Nothing else is relaxed by this exception. In particular it does not weaken:

   - Immutable Releases, which must stay enabled on the repository (`enabled=true`, re-read from `GET /repos/zieglar/pi-packages/immutable-releases`).
   - The `ce-sqlite-v*` tag ruleset `26078349` (active; update and deletion blocked; no bypass actors; `current_user_can_bypass: never`), which keeps the release tag pinned to the build SHA server-side.
   - Public `main` protection against force push and deletion, binding administrators.
   - The release script's own refusals (existing version, ambiguous or failed API responses, disabled immutability, incomplete or extra asset set, write-stage failures) and the exact 8-file release inventory.
   - The artifact and attestation requirements: the release job still verifies `SHA256SUMS` and every subject's signed bundle against the repository, signer workflow, source ref and exact source commit SHA before publishing.
   - The `native-sqlite-release` deployment branch policy, which remains restricted to `main`, and `can_admins_bypass=false`.

Gate effect: G6 is recorded as `PASS_WITH_SINGLE_MAINTAINER_EXCEPTION`. It is not an unconditional pass and must not be read as independent approval. `READY_FOR_RELEASE` may only be stated as `YES_WITH_EXCEPTION` while every other Gate is PASS.

Change provenance: the exception is realized by setting `prevent_self_review=false` on the environment via `PUT /repos/zieglar/pi-packages/environments/native-sqlite-release`. Required reviewer (`zieglar`), `can_admins_bypass=false`, the `main`-only deployment branch policy and the environment name are unchanged. No environment was deleted, recreated or stripped of its approval requirement, and no other repository administration setting was modified in the same step.

Not verified by configuration alone: this exception does not prove that a future real deployment approval will succeed, and no `publish=true` run was triggered to test it. Actual Release execution remains separately authorized.
