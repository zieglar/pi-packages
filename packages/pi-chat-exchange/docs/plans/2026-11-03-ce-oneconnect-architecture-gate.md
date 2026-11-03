# One-command Session onboarding: architecture gate

Handoff: HANDOFF-CE-SESSION-ONBOARDING-01, continuation of the reviewed and integrated onboarding work.

Status: **BLOCKED at the live-admission architecture gate; no product behavior implemented by this continuation.** This is a design and evidence record, not a claim that live admission is fundamentally impossible. The existing supported APIs cannot meet the required live-join behavior while retaining their current lifetime and publication contracts. A reviewed architecture amendment is needed before implementation.

## Authorized target and fixed baseline

The normal user action is `/ce-tunnel connect`. A first confirmation must cover this native Session's stable independent Endpoint, payload-read exposure and reception ACK; Hooks remain disabled. Decline must leave registration, grants and Owner unchanged. Previously authorized Sessions reuse grants without repeated consent. New Sessions must join a running shared transport without stopping/replacing it or disrupting existing Sessions. Disconnect must release only the current binding, retain the grant and leave shared transport running. Real messages addressed to each new Endpoint, peer payload reads and exact reception ACKs must be verified separately from transport health.

The user authorizes implementation, targeted tests, review and a local commit, but explicitly requires stopping at a proven frozen-architecture/protocol/Store-schema gate. No Push, Merge, Release, production installation or interruption of the running production transport is authorized. The task message was read through the already-running original Owner; it is not itself an additional source of authority beyond the user instruction.

Baseline: private main `64f6f1b4819d1316b293a948d63f690f63965d4f`, tree `7d2d988647d8091017be9d82997c530cac150ba0`; upstream origin/main, cached ahead/behind 212/0. Active installation is `0.3.1-daily.1-onboarding-f504461`, package version `0.3.1-daily.1`. Work is isolated at `/Users/zieglar/Code/pi-packages-ce-oneconnect-01`, branch `feat/ce-oneconnect-01`. Main tracked files were clean; original untracked hashes were preserved. Production Profile, credential, installation and Tunnel lifecycle were not changed during the gate investigation. Prior Daily Integration CLOSED status is unchanged.

## Reproducible constraint chain

1. `src/tunnel/background-manager.ts:1734` exposes `withProfileConfigurationLock`; lines 1742–1746 reject a non-stopped ledger or a matching process. `src/tunnel/multi-session-policy.ts:220` routes every register/revoke publication through this gate. Publication replaces the Profile's immutable binding pointer at lines 231–257. A new recipient cannot currently be published during a running shared transport.
2. `src/tunnel/multi-session-admission.ts:16` captures the actual launch policy once. Each later call at lines 20–24 intersects the launch grants with the selected policy and may only deny. `src/tunnel/multi-session-policy.ts:171–178` filters **loaded** recipients; publishing a new recipient does not add it to a running MCP.
3. `src/host/endpoint-host.ts:443–452` fixes payload-read, ACK and recipient policy for a Host lifetime; constructor lines 469–473 captures those decisions. `send` at line 822 checks the frozen recipient map before Storage admission. Removing the outer deny-only check would still not authorize the new recipient in the actual Host.
4. `src/bin/mcp-stdio.ts:122–146` constructs one Host from the launch configuration and starts one `CeBoundEndpoint` with `requireUnowned`. The existing bound port owns one heartbeat, admission/in-flight state and shutdown path (`src/host/bound-endpoint.ts:96–118,198–267`). There is no supported live Host-policy replacement operation that transfers this lifecycle while preserving admitted calls and the existing chatgpt/main Owner.
5. The current launch identity and startup permission are exact: `src/tunnel/background-scope.ts:59–65` includes Profile hash, script identity and binding path/content in the authorization scope. Registration changes the Profile/binding pointer. Live selected-policy evolution therefore needs a separately specified relationship to the unchanged running launch identity and future startup consent; it cannot simply be treated as the same launch configuration.
6. `docs/architecture.md:59–62` explicitly describes STOPPED publication, fixed Pi factory grants, explicit MCP Stop/Start for a new generation and deny-only later admission. Altering this chain is an architecture/authority-lifecycle amendment, even if it ultimately needs no protocol or SQLite schema change.

The ordinary case is sufficient to expose the conflict: MCP starts with A; B is a brand-new native Session and absent from both the loaded recipient set and Host recipient map; explicit B consent publishes B. Under current invariants A remains usable and B must remain denied until a new MCP launch. The requested outcome requires the same running MCP to begin sending to B. Both cannot hold without a changed live-policy contract.

A superficially small workaround has a concrete failure path: bypassing only the STOPPED lock publishes B and changes the Profile pointer, but the running MCP still denies B. Removing the deny-only check as well still leaves Host recipients fixed. Replacing the Host or widening its map then changes the authority/lifecycle boundary and must account for existing Owner/fencing, drain, heartbeat, revocation, Hooks and uncertainty. This is deterministic for every genuinely new recipient, not a theoretical rare race.

## Fresh characterization evidence

Using Node 24.21.0, pnpm 12.9.1, offline frozen dependencies and an isolated build:

```text
pnpm exec vitest run test/tunnel/multi-session-admission.test.ts test/tunnel/multi-session-policy.test.ts test/endpoints/pi/session-onboarding.test.ts --maxWorkers=2
```

Result: **3 files, 24 tests passed**. These are existing behavior/contract characterization tests, not new-feature tests and not real cloud acceptance. Logs: `/private/tmp/ce-oneconnect-characterization.log`; isolated build log `/private/tmp/ce-oneconnect-build.log`.

- `test/tunnel/multi-session-admission.test.ts:26–43`: the launch gate rejects newly published B, permits unchanged A, and never revives a revoked epoch.
- `test/tunnel/multi-session-policy.test.ts:49–56`: selected policy can project B for a newly loaded Pi factory while the old MCP recipient set stays A-only.
- `test/tunnel/multi-session-policy.test.ts:87–91`: running/unknown process state refuses publication and leaves the Profile unchanged.
- `test/endpoints/pi/session-onboarding.test.ts`: default false/false grants, no publication on decline, current-generation fences and running-transport refusal.

The prior real two-way test through the original pi/main remains valid for that Endpoint. Neither that test nor CONNECTED supplies evidence for this new-Endpoint flow. No new-version real TUI/cloud test was attempted because there is no authorized live-admission implementation to exercise, and the production installation may not be replaced.

## Alternatives and smallest proposed amendment

**A. Compose existing commands and retain STOPPED publication.** Smallest UI change, but it cannot satisfy running-shared-Tunnel admission. Automatic Stop/Start would violate the requirement and interrupt existing Sessions. Do not present this as full acceptance.

**B. Versioned live admission in the existing composition and Host lifecycle (recommended design for a separately approved amendment).** Keep one MCP Endpoint Owner and the existing Store authorization rules. Specify an explicit operator-authorized, revision-checked registration publication that does not rewrite an active launch identity. A running MCP must validate and acknowledge the exact proposed policy generation before Connect reports messaging ready. Extend the existing Host/bound-port lifecycle with one reviewed transition from old policy to successor policy: stop new admission for the transition, settle already admitted calls, retain or recover only the same proven Owner/incarnation through supported capability handling, maintain one renewal owner, atomically expose the new policy, and apply revocation/epoch/Hook checks to subsequent admission. Unknown transition state must fail closed with reconciliation evidence, not retry sends or create another authority. Pi factory reload may load its own approved projection through official Pi lifecycle. No model-supplied Endpoint/Session/capability is trusted. Whether the current Host resume API can safely transfer all in-memory authority without disrupting A must be proven, not assumed.

This is a proposed contract, not an implemented algorithm or a finding that its concurrency and crash behavior already work. Design must first resolve: authenticated writer and reader serialization; actual launch versus selected generation; compatibility with old clients; publication/adoption acknowledgement; crash windows and rollback; revocation concurrent with adoption; permissions broadened versus narrowed; startup consent scope; tool availability and in-flight calls; shared ChatGPT Owner and one heartbeat; Hook runner lifetime; process identity/health continuity. Existing SQLite schema and protocol could potentially remain unchanged, but that has not been established.

**C. Parallel MCP Host, extra Tunnel, recipient wildcard or automatic pi/main adoption.** Reject: introduces another authority/transport, broadens recipient grants or defeats Session isolation. A supervisor that restarts/replaces the MCP child under the same client is also not proof of zero interruption and is not an existing supported lifecycle here.

Do not implement A as a partial substitute before resolving B. It would change first-Connect grants, confirmation sequencing and Disconnect semantics while leaving the core requirement blocked. A later implementation should apply the complete consent transaction only after its publication/adoption semantics are defined.

## Required implementation/acceptance sequence after the gate

1. Approve the narrow live-policy and same-Owner lifecycle contract, preserving recipient-only Storage checks, independent stable Endpoints, no takeover, deny-only revocation and Hooks OFF. Make any intentionally changed existing invariant explicit.
2. Add failing tests for new running-transport B admission while A exchanges messages; old generation, stale revision, epoch replay, cancelled consent, publication/adoption uncertainty, concurrent revoke, capability/Owner continuity and no duplicate renewal or effects. Then implement the smallest supported transition.
3. Combine first registration and payload/ACK consent into one cancellable transaction. Explicitly upgrade existing false/false registration only after consent; retain remembered true/true grants. Separate persistent transport-start permission if its exact scope is absent or changed. No credentials, capability or mutable display name becomes registration identity.
4. Make normal Disconnect release only the current binding; retain separate advanced Stop. Status reports Endpoint, current binding/lease, payload/ACK and transport evidence independently.
5. In isolated real Pi 1.3.0, verify STOPPED A and RUNNING B using only Connect. Record unchanged runId/PID, A Owner/heartbeat/message continuity and independent B mapping. Default decline must create no registration/grant/Owner. Repeated authorized Connect must not ask again or duplicate registration. A B→ChatGPT test and ChatGPT→B test require real peer reads and exact receipts; cross-A/B and pi/main reads/ACK must refuse. No uncertain outcome resend.
6. Freeze code/tree/patch for correctness, security/authority and validation reviews. Build/typecheck including extension, run affected Host/MCP/Pi/Tunnel/Hooks regressions, then local commit. No merge, publication or installation is implied. A real candidate ChatGPT test needs a safely isolated supported peer route; without it report UNVERIFIED.

## Current deliverable boundary

This branch records the architecture gate only. No implementation is claimed, no product source/tests were changed, and none of the six new one-command acceptance goals is marked passed by this continuation. The preserved 24 passing characterizations demonstrate existing behavior. Any local commit here is a documentation/evidence commit, not a feature-completion commit. Prior installed behavior and Daily Integration CLOSED status remain unchanged.
