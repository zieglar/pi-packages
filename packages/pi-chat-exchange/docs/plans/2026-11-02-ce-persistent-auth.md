# CE persistent background startup authorization implementation plan

Handoff: HANDOFF-CE-PERSISTENT-AUTH-01. Baseline branch feat/ce-daily-ux-01, HEAD 5a699c13407a95a89009ac74b82448350997f68f, clean, no upstream; origin/main ahead 172 / behind 0. User explicitly authorizes replacing the Tunnel-local process opt-in with safe persistent permission; frozen Host, protocol, Store and Ownership authority remain unchanged. No production install or configuration changes.

## Goal and design

Ordinary `pi` can use `/ce-tunnel connect` after explicit first authorization without a Shell wrapper or environment opt-in. A fixed OS-account private store holds per-profile grants/revocations and non-authoritative Profile/Client selection. Grants bind exact profile bytes and path, credential reference/metadata, admitted Client/wrapper, approved Node, this installation's MCP script and binding content. No credential body is read or saved by authorization. Same-UID malicious code is outside the existing filesystem trust boundary.

Alternatives considered: a Profile boolean lacks an independent trust boundary; existing Keychain support is macOS-only and offline credential-scoped. A private strict authorization record reuses local filesystem permission patterns without adding a daemon, service or message authority.

## Ordered work and file ownership

1. `src/tunnel/background-authorization.ts` and its isolated tests own bounded strict records, UID/mode/no-symlink/ACL checks, exclusive private writes, rename/file+directory sync, non-authoritative selection, and revoked tombstones. Missing is distinct from invalid. No automatic repairs. Rename is the commit point; post-rename sync failure is uncertain, never rollback. Before trusting a previously visible grant/selection, inspection establishes directory-sync success again.
2. `src/tunnel/background-scope.ts` validates exact launch scope. `background-manager.ts` owns final authorization at Start/StartDeferred entry and just before spawn, restores saved selection through the existing production selector, accepts caller expected-profile digest, and exposes narrowly scoped grant/revoke/status methods. Revoked/invalid/changed managed records override env1; env1 is legacy compatibility only with absent managed record. Fresh scope is checked after confirmation and immediately before spawn.
3. `pi-extension/index.ts` owns trusted interactive confirmation, cancellation, cached-manager target identity and permission routing. `/ce-tunnel permission status|grant|revoke` reuses existing command hierarchy. Revoke is before daily-operation busy checks and outside lifecycle/configuration queues. It does not require a valid scope or STOPPED transport. Confirmations target the actual Manager profile and refuse changed selection. Cancel grants/activates/spawns nothing. Explicit grant can persist even if legacy env1 is present. Grant/selection commit uncertainty aborts current connect. Existing daemon needs explicit Stop/disconnect after revoke.
4. Extend lifecycle and command tests plus independent-process persistence tests. Existing test guard directs all default stores to isolated test paths, never the account's actual permission files. Scope/Native/transport doubles remain explicitly labeled; independent Node processes exercise real production executable selection with only OS account home redirected. No client execution in restart check.
5. Update bilingual daily-use, setup, operations, background-manager and extension README/help; remove Shell configuration as a daily requirement. Retain same-native-session ownership constraints and distinguish binding, transport, model availability, ACK and task completion.
6. Run build/typecheck/check, focused permission/command tests, Tunnel/Pi regression, and unchanged Ovis/Wake regressions. Freeze exact file set and patch hashes for four standalone review lanes. Resolve supported blockers, then authorized local commit only. No push, merge, release or production installation.

## Design/security review closure

- Save Profile and selected Client reference in strict user-private selection; restore via production admission, not `clientPath` test dependency or child-environment injection. New-process checks remove all CE_TUNNEL variables.
- Revoke is available while connect/start waits; its synchronous durable record is rechecked before spawn. No STOPPED lock or queue dependency.
- Pre-rename failure leaves old record; post-rename directory-sync failure aborts continuation and reports uncertainty. Future inspection requires successful directory sync before any visible grant/selection is trusted, not an unverified durability claim.
- Confirmation/write target is Manager's own profile; changed external selection refuses. Hard-linked/nonordinary profiles refuse before scope parsing; scope configuration fd checks exclude credential inode before reading.
- Final review remediation: Stop aborts a pending direct Start confirmation; a late acceptance neither grants nor starts. Authorization/selection records require one hard link. Script-only drift is exercised in an isolated relocated installation with unchanged Profile/binding/client and zero spawn.
- Revocation admission semantics: starts that obtain their final grant snapshot after revocation refuse. An overlapping start that already obtained the snapshot may validate and spawn after revoke returns. This is not a process-creation barrier; explicit Stop/disconnect handles transport. Same-UID malicious restoration of private files remains outside the trust boundary.

## Verification limits and process evidence

Initial store tests were written and failed before first implementation. Additional durability/selection cases were implemented before a retroactive old-implementation failure check; this is explicitly not strict RED/GREEN evidence. Manager integration tests failed before its implementation. Later command/security cases add coverage without claiming fabricated RED runs.

Store, Manager, command handler and independent-process tests use isolated files and controlled process/Native boundaries. Real Pi TUI restart, production deployment, real cloud/Desktop handshake and long-duration behavior remain unverified. Installed CE 0.3.0 is unchanged; historical source metadata 0.2.2 remains untouched.

Stop on baseline drift, conflicting concurrent edits, required production operations, or a supported frozen-authority blocker. Continue safe ordinary regression remediation within this handoff; stop adding unrelated architecture once criteria pass and no blockers remain.
