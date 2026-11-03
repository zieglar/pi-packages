# Live Session Connect

Live mode gives each trusted native Pi Session a stable, independently authorized Endpoint while sharing an existing ChatGPT peer and managed Tunnel. It is selected explicitly by a `ce-live-session-v1` launch descriptor. It does not change Protocol, Store schema, Owner recovery or task-completion authority. See [architecture](architecture.md) and [legacy multi-session usage](multi-session-usage.md).

## Select live mode explicitly

`/ce-tunnel migrate-live` is an advanced offline operation, not part of Connect. Close the local binding and stop all legacy writers first. The command requires Native readiness, explicit confirmation, the exact selected Profile revision and the Manager's verified STOPPED configuration lock. It creates a new private policy chain and publishes an immutable launch reference. It neither stops nor starts transport. Reload Pi explicitly afterwards. A failed or uncertain migration must be inspected, not automatically retried.

Legacy `ce-multi-session-v1` remains unchanged: new onboarding registrations retain payload read=false and ACK=false, existing registrations return ready without changing consent, and legacy configuration/activation keeps its STOPPED-lock and explicit reload/Stop/Start requirements. Legacy Disconnect can stop the shared Tunnel; check its confirmation text.

## Connect each Session

Run `/ce-tunnel connect` from the intended native Pi Session. A first live registration, or an explicit upgrade of that Session's disabled read/ACK bits, previews its exact Endpoint, Store, Exchange and peer. Accepting enables payload read and ACK for that Session; ACK acknowledges reception only. New registrations have no Hooks. Existing separately authorized Hooks are preserved; messaging consent enables no Hook or task execution.

The dialog discloses that the exact Endpoint label is visible to the configured peer. Truthful first-send outcomes can reveal first join/addressability even when optional presence telemetry is withheld. A separate optional confirmation covers both Exchange membership/first join and current Owner/lease liveness. Declining that optional disclosure leaves presence-dependent discovery states unknown. A true/true active registration reuses its grants without repeating messaging consent or silently enabling presence disclosure. Revoked registrations are not restored by Connect.

Declining messaging consent writes no registration. Session, environment, selected Profile and policy changes fence the pending operation. An unresolved publication blocks another publication; cancellation after a commit does not erase committed grants. No automatic rebase, resend, takeover or recovery follows an unknown outcome.

Publication is configuration, not binding. Connect uses official Pi reload when the factory must load new grants, then rechecks the same Session and policy. Binding uses the current Session's projection and refuses an existing Owner; it cannot adopt another Session by copying its ID. Live publication/activation does not require stopping a compatible running shared transport. A stopped transport still needs explicit startup permission for the exact Profile/client/script/credential-reference scope. A remembered selection is not permission; scope changes require fresh consent. Connect can start an authorized stopped transport or reuse a verified existing run. Transport health alone cannot establish MCP policy adoption or messaging readiness.

`/ce-tunnel disconnect` in live mode closes/releases only the current Pi binding and retains its registration, grants and history. Other Owners and the shared Tunnel remain. `/ce-tunnel stop` is a separate advanced shared-transport action. Release uncertainty remains fail-closed; Connect does not repair it automatically.

## Choose exact recipients

The optional live-only MCP tool `ce_endpoints` takes an empty object and returns the caller's own identity/effective operation booleans plus currently send-authorized exact target labels. Composition filters before observation. It exposes no native Session IDs, another Endpoint's read/ACK/Hooks grants, hidden-target counts or arbitrary label probe. `/ce-tunnel liveSessions` currently reports only the Pi caller's own identity when no discovery port is available; it does not enumerate the full registry.

Discovery is advisory and each actual send reauthorizes. Use the exact intended label in `ce_send.to`. A reply may use an incoming sender only when the user intends that reply; otherwise ambiguity requires explicit target selection. The server verifies exact addressing authority, not proof of user intent. There is no signed target-selection proof, latest-Session inference, `pi/main` fallback or automatic redirect. Shared `chatgpt/main` is a shared inbox, not isolation between ChatGPT conversations.

| State | Meaning and limit |
| --- | --- |
| Registered | An active policy registration; no claim of membership, Owner or processing. |
| Authorized | This caller has the current operation/recipient grant; final Host/Storage checks still apply. |
| Active | Advisory current Owner/ATTACHED Session/ACTIVE lease observation; false or unknown is explicit. |
| Reachable | Advisory durable-addressing eligibility at the adopted policy and serving transport, including membership; independent of whether the recipient is processing. |

Active and Reachable use `true`, `false`, `unknown`. Withheld presence masks membership-dependent information. Missing/stale evidence, policy changes or observation uncertainty yield unknown. A terminal blocked MCP port cannot become ready merely because transport is healthy or a later registration appears. Registration, authorization, active lease, reachability, local Message persistence, cloud delivery, ACK/Receipt and business-task completion are separate facts. Discovery performs no send, join, renewal, payload read or Hook.

## Observation and recovery limits

Exact running-child observation uses managed run identity, process ancestry/start identity, launch identity and fresh bound-port/Owner evidence. The real process-observation path has been tested only on macOS; Linux support in the implementation is not equivalent platform evidence. Paths containing whitespace and ambiguous wrapper/argv rendering remain UNVERIFIED. A PID, recent file or CONNECTED status alone is insufficient. Without fresh attestation, report UNVERIFIED; do not infer cloud delivery or restart another Session's runtime. These docs make no actual cloud A/B, installed-package, ACCEPT or CLOSED claim.

The policy chain uses immutable, exclusive next-slot publication, bounded to sequence 65,536 and 64 MiB of history; individual policy files are bounded to 65,536 bytes. Publication reconciliation is bounded to 1,024 intent locators per native Session. Exhaustion refuses new writes; it is not automatic compaction. Operation-ID locators distinguish observed publication, competing commits and unresolved attempts. Committed history missing its required locator is detectable. Deletion by the same OS user of an uncommitted locator can leave no evidence for a fresh process; private filesystem permissions and watermarks are not tamper-proof storage, a lock or an exactly-once guarantee. Unknown durability is never permission to retry or roll history back.

After the chain advances, selecting an old manifest or deleting history can resurrect revoked registrations or old grants. Rollback requires an independently reviewed offline migration that retains current facts, revocations, epochs and permission generations, with all writers stopped and verified. Do not move the chain backward, delete commits or treat binary rollback as consent restoration. This document authorizes no production migration, installation or release.

## Local validation

From `packages/pi-chat-exchange`, use the existing scripts with the intended Node version (this implementation's focused evidence used Node 24.21.0):

```sh
pnpm run build
pnpm run typecheck
pnpm test --maxWorkers=4 test/endpoints/pi/extension-live-connect.test.ts test/endpoints/pi/live-session-onboarding.test.ts test/endpoints/pi/extension-multi-session.test.ts
pnpm test --maxWorkers=4 test/tunnel/live-session-policy.test.ts test/tunnel/live-session-migration.test.ts test/tunnel/live-process-observation.test.ts test/tunnel/live-connection-status.test.ts test/control/mcp/endpoint-discovery.test.ts
```

Package typecheck does not replace the extension's separate typecheck in the implementation review. Synthetic Manager/Store tests prove only their exercised boundaries. Real peer, installation, platform and cloud acceptance need separate authorized evidence. Local commit/review decisions remain with the parent workflow; these commands are not release authorization.

## Explicit reauthorization and diagnostics

`/ce-tunnel reauthorize <exactEndpoint> [--payload-read] [--ack]` is live-only and applies only to the current native Session's exact tombstoned Endpoint. Connect and register cannot restore it. Confirmation previews revoked epoch → epoch+1 and the explicit read/ACK booleans. Optional presence disclosure is independently confirmed and defaults to false; separately authorized Hooks are preserved by omission. Old factory generations remain denied until official reload. Reauthorization changes no Owner or capability and performs no takeover: an old held Owner needs normal release, while an expired/uncertain Owner requires separate operator recovery. Revoking the last registration can permanently stop renewal for the current MCP incarnation; later grants do not restart its heartbeat.

Live Connect checks both global MCP payload-read and ACK ceilings before confirmation or ready reuse. Disabled ceilings require explicit offline setup and publish no Session grant. Advanced register/reauthorize may request only bits allowed by those ceilings; an explicit false/false metadata-only registration remains possible. Passive descriptor loading does not enable grants.

Before `migrate-live`, the legacy MCP global payload-read and ACK ceilings must already both be enabled. Otherwise migration refuses before any writes; migration cannot broaden these launch grants implicitly. Legacy fallback is limited to a never-selected, absent Profile. A selected Profile that is missing, unreadable or unavailable must produce an unavailability error (S6), not silently select legacy defaults. Unavailability identifies a failed read/access boundary; unknown is an observation result and does not prove absence or grant permission.

The dead-recorder observation module is diagnostic/test evidence only. Its records cannot establish readiness acceptance or replace a fresh bound-port attestation.
