# Hooks management: bounded contract design result

Handoff: `HANDOFF-CE-HOOKS-MANAGEMENT-01` (same continuing task).
Disposition: **READY_FOR_IMPLEMENTATION_AUTHORIZATION**.
This is a completed design gate, not implemented functionality or production approval. The current round explicitly authorizes no implementation-source changes, script/test execution, installation, production configuration or Git commits; those restrictions were retained.

## Fixed design and reviews

Design: `docs/plans/2026-11-04-ce-hooks-contract-amendment-design.md`, D1.
SHA-256: `d8c72175a3472c569a04a5cebe1ebedcc301c0b0a00ee15095a3cb1e53644906`.
HEAD: `894ea9eddd88841fa667748cda7af98815b99785`.
Worktree: `/Users/zieglar/Code/pi-packages-ce-hooks-management-01`.
Branch: `feat/ce-hooks-management-01`.

Both reviewers verified identical start/end design hashes and HEAD. The parent rechecked the fixed hash after both completed. The reviewed D1 remains unchanged; the nonblocking clarification below is recorded separately.

| Review | Result and limit | Session identifier |
|---|---|---|
| `hooks-contract-security-d1` | PASS: both contracts sufficient for implementation-authorization consideration; no identified frozen Core/Store/Protocol exception | `485e1916-122e-4c16-963e-a2eac656ce2c-5751fac2-bde6a7b1-d1d1` |
| `hooks-contract-plan-d1` | PASS: design sufficiently concrete and implementable; one low-priority locator/reader clarification, no further research task required | `42701280-3878-41ca-8514-879b8ffbb0d7-618224e0-0443b54f-323f` |

Both used the configured `magpie/group/expert` route. No cross-family-independence claim is made. Neither reviewer ran tests or accepted a future implementation, and neither review grants deployment or workflow-transition authority.

## Two gates resolved at design level

1. **Inbound MCP sender consent.** A sender-scoped chain record binds the exact immutable binding/sidecar generation (and therefore static configuration/rules), confirmed per-rule target Endpoint/Session/epoch tuples, and a captured consent generation. Expected-tip CAS is the consent commit point. Adoption and each actual start check exact binding selection, rule identity, current target and generation. Revocation/reauthorization after confirmation cannot be replaced by a fresh process's new epoch; disable/re-enable of identical bytes cannot revive an old loaded process. Receiving Pi outbound Hooks are never inbound authority.
2. **Outbound Pi update continuity.** In the explicitly selected v2 mode, own Hook-generation changes invalidate old Hook starts without becoming ordinary message permissions. Identity, epoch, independent read/ACK generations, mapping, same-Owner mutex/transfer and existing fail-closed behavior remain. New Hooks require official reload; all identified operation, registration, transfer-preparation and pending-transfer checks are covered. A failed reload does not resurrect the old runner or acquire another Owner.

The compatibility design validates the original v1 prefix, appends a unique v2 marker in the existing exclusive next slot, and preserves root/genesis/policyId plus all tombstones and existing permission facts. It does not reset genesis, pretend the Profile lock fences live writers, or silently relax old parsers. Chain consent and Profile selection are separate commit boundaries with explicit crash/uncertainty handling.

## Nonblocking clarification: locator actor and reader handover

The parent checked `src/tunnel/live-session-policy.ts:204-255`. Its current `load()` is bound to the v1 reference/reader; both `reconcile()` and `publish()` infer locator ownership only from register/reauthorize/revoke. Therefore “reuse locator/publication” does not mean calling that unchanged entrypoint for new intents.

Implementation must extend the **same private policy module's** explicit intent dispatch:

- Preserve legacy register/reauthorize/revoke actor inference and all prior locator-integrity checks.
- For `set-pi-hooks`, derive the locator actor from the trusted current native Session and require it to match the exact edited registration/incarnation.
- For `set-mcp-hooks` and the upgrade marker, use the trusted native operator actor recorded in the closed intent. Do not infer it from one of the possibly multiple target registrations.
- Retain the existing locator fields, namespace, bounds, fsync ordering, parent/candidate/operation digests and no-overwrite CAS. “Locator actor/owner” here means publication-record attribution, never a CE Owner row, lease, capability, lock or authority conferred by the record.
- Extend reconciliation's committed-intent scan for every new intent. A committed operation with a missing required locator must remain detectable; unknown intent/actor mapping must fail closed, not be skipped.
- Before upgrade publication, verify the original exact v1 tip and reconcile its outstanding requests. After an observed marker commit, use the **precise prepared/pinned v2 reference** to verify the original prefix, marker and result. Do not invoke the old v1 `load()` after a successful marker and mistake its expected unknown-format refusal for failed publication.
- In conflict or unknown outcomes, classify only from validated parent/slot/operation evidence. A valid different exclusive-slot winner is a competing commit, not permission to adopt it. Unprovable or unsupported evidence stays unknown. Read-only reconciliation never repeats the marker, rebases consent, rewrites history, restores old grants or activates a candidate.

Future acceptance cases include all new intent actor namespaces, missing locators after commit, marker link-success/result-loss, post-marker reader handover, competing v1/v2 next-slot winners and Profile-selection-pending crashes. These supplement D1's matrix; they are not executed tests in this round. The clarification changes no data authority or selected architecture and is the exact low-priority implementation boundary called out by the plan reviewer.

## Evidence and retained limits

Only the D1 document and this result report were added in this design round. Existing R2 design/report and characterization-test deltas remain historical work, unchanged by this round. Read-only source checks and `git diff --check` were performed; no build, test suite, fixture, personal script or other repository script was run. The earlier 104 passing tests and build/typecheck logs remain evidence for the original baseline/characterizations, not verification of v2 behavior.

The following must still be demonstrated by implementation: both race schedules, full rule/binding/incarnation enforcement, ABA, upgrade prefix/marker/locator validation, crash reconciliation, actual MCP adoption and Pi reload/transfer, unchanged v1 and unrelated-Session behavior, static-command and metadata-only boundaries, and the integrated Hooks manager. No production Tunnel, Store, Owner, configuration, grant or installation was changed. No Git commit, merge, push, PR or release occurred.

Admitted-before-revocation operations may still spawn/finish under the documented final-read linearization; private files are not tamper-proof against their account owner; the explicit format upgrade can interrupt service, and surviving Owners require existing independent cleanup. These are declared boundaries, not new frozen-authority exceptions.

## Continuing implementation scope

The design is ready for one bounded implementation authorization in this same Handoff, using D1 plus the locator/reader clarification above. That scope includes private v2 configuration/intent/readers, upgrade orchestration, MCP sender consent enforcement, Pi Hook/message/reload continuity, and the previously requested Hooks-management UI with targeted tests and fixed-diff security review. No new research Handoff or separate task per gate is needed.

This report supplies no new implementation authority in a round that explicitly withheld it. Production configuration, installation, personal scripts, transport operations, Git commits and publication remain separately unauthorized. If actual implementation reveals a Core/Store/Protocol dependency, baseline drift or conflicting edits beyond the reviewed private amendment, stop at that concrete boundary and report it rather than expanding scope.
