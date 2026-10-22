# Local Tunnel setup and Manager

`/ce-tunnel` is the interactive entry point. Direct `setup`, `status`, `start`,
`stop`, `migrate`, and `help` subcommands remain shortcuts. Configuration is not connectivity:
**Configured != Connected**. Transport health is never message delivery, ACK,
reconciliation, or completion evidence.

## Interaction and ownership

Standard screens use `@narumitw/pi-tui-kit` **0.66.0** on Pi **1.3.0**:
`defineMenu` / `runMenu`, action, input, review, and detail screens. The extension
owns draft domain state, validation, identity-change confirmations, persistence,
and session cancellation. The transaction layer does not depend on widgets.

API key entry is **CE custom masked secret input hosted through Pi 1.3.0
`ctx.ui.custom()`** (`src/tunnel/secure-input.ts`). It is not a Pi-native
PasswordInput or SecretInput. The Kit's ordinary input is never used for a key.
Kit 0.66.0 also supplies a generic masked interaction; CE retains its specialized
bounded ASCII/paste validation, sink-only result contract, and timeout policy.

First setup is four numbered steps: Tunnel ID (required, with its format stated
inline), optional Organization ID, the masked API key — entered directly, with no
intermediate credential choice — and Review. Editing an existing profile replaces
step 3 with Keep existing credential / Replace credential. Recipients are not a
linear step: CE has no trusted endpoint discovery, so they live behind
**Review -> Back - Edit configuration -> Advanced - Recipients** and default to the
CE-managed empty list. The review shows only nonsecret configuration and
credential intent. Only final Save enters the transaction. The MCP binding is
never a typed file path: it is derived from the tunnel identity as a CE-managed
document (`ce-<tunnel tail6>-<org tail6>.yaml`, preserving case, under a fixed
`.ce-bindings` directory beside the profile). An unchanged existing valid managed
binding is reused by exact identity + content match; a changed recipients list
writes a new digest-suffixed generation without mutating the base; a same-name
file carrying a different identity is refused, never reused or overwritten.
Existing-profile editing keeps the binding untouched unless recipients change OR
the tunnel identity (Tunnel ID / Organization) changes while the current binding
is CE-managed — in that case the binding is regenerated for the new identity,
carrying the existing recipients unchanged.
Keeping a credential does not read its content.
Identity or recipients changes require an additional old-to-new review/confirmation.
Escape, Cancel, interaction timeout, or disposal of a nonsecret Kit page resolves
as `CANCELLED` before Save; the wrapper drains Kit's pending handler barrier and
does not write profile, credential, or Keychain. Starting is always a separate
explicit action.
## Binding selection is static validation, not authority acquisition

No historical binding or Store is automatically selected. A CE-managed binding
is generated only from the tunnel identity and the operator-entered recipients,
with minimal permissions (`recipients` defaults to `[]`; payloadRead, ack, and
debugExecutionGuard disabled). The generated document is still validated by the
formal MCP binding parser before any reference. It does not open/create the
configured Store, bind an endpoint, read/ACK/send a message, launch a child, or
establish a network connection; the Store is created lazily by the MCP server on
first use, not by setup.

## Persistence and concurrency

A replacement key is written to a random generation inside a dedicated
operator-owned `0700` credential directory. On macOS its inherited ACL is removed
with the platform-native `chmod -N` **before** any secret file is opened; failure
to establish that directory isolation refuses setup. The generation uses exclusive
create and mode **0600 at creation**, then syncs its contents. Because a directory
fsync persists only that directory's own entries, setup also syncs **both** the
credential directory (which holds the generation's name) and the profile directory
before the commit. A complete temporary YAML references only `file:<generation>`.
Atomic profile rename is the logical commit point. Precommit failures — including a
failed directory sync — preserve the previous profile and credential; cleanup
removes only this transaction's new files. Keep uses the existing reference
unchanged.

After commit, setup syncs the profile directory and every profile-directory entry
created while obtaining the manager lock. A failure to establish durability returns
`durability: uncertain`; it never reports rollback for an already renamed profile.
A crash/SIGKILL before commit may leave an unreferenced private generation or temp
file. If the filesystem refuses cleanup, setup reports a sanitized failure rather
than falsely claiming zero-side-effect cancellation. The previous effective profile
remains unchanged; cleanup of such residue is an explicit operator follow-up.
Successful replacement deliberately retains old credential generations to avoid
breaking old readers or deleting files with uncertain ownership. Credential
**garbage collection is follow-up work**, not an automatic setup side effect.
The credential is plaintext at rest in a private operator-owned file.

Setup and start coordinate through the same ownership boundary. ACTIVE or
uncertain ownership blocks editing; setup never automatically stops a client.
Start rereads/revalidates the profile under that boundary. The exact real-start
gate remains `CE_TUNNEL_BACKGROUND_ALLOW=1`; no setup, refresh, or session startup
implicitly grants it or starts a client. The 45-second background startup budget
and recovery/ownership authority remain unchanged.
Real Start returns to the command loop without waiting for readiness. A spawn
acknowledgement shows STARTING; repeated Start requests in the same session are
merged until the terminal result. `/ce-status` uses a plain notification when the
Manager already owns the custom screen. Close ends only that screen, not the
background start; session teardown suppresses deferred notifications without
replacing the manager's ownership or cleanup authority.

**Runtime health is not configuration authority.** An unavailable runtime
(UNKNOWN state, no healthy daemon, missing client binary) never blocks repairing
a missing/invalid/incomplete profile: the Manager offers **Set Up Tunnel** (no
usable configuration) or **Edit Configuration** (partial/invalid) whenever the
configuration projection says repair is needed, regardless of runtime state.
Setup safety is decided solely by ownership/lock evidence — an ACTIVE or
STARTING/STOPPING owner, a held configuration lock, a foreign profile reader,
or an ownership inspection that cannot prove safety all still refuse closed.
`UNKNOWN → Start Tunnel` remains impossible; `UNKNOWN` is never mapped to
`STOPPED`. Setup cancel returns to the Manager with zero side effects; a saved
setup rereads a fresh projection and never auto-starts.

## Profile schema compatibility and in-place repair

The real `tunnel-client` 0.0.16 rejects two `admin_ui` keys the generator once
emitted: `allow_remote_ui` (a top-level client flag, not an `admin_ui` member)
and `log_buffer_events: 0` (must be > 0). The profile generator and the start
decoder now emit/accept only the canonical `admin_ui.open_browser: false`;
`tunnel-client doctor` validates the generated profile as a regression guard so
the offline simulator cannot mask a schema mismatch again.

The MCP child's `node` executable must resolve to the Store-approved `v24.21.0`
(see `storage/runtime.ts` `APPROVED_NODE_VERSION`) — a Node 25 runtime is refused
by the durable Store's exact-version check. Setup resolves that Node without
hardcoding a machine path (preferring the running runtime when it matches, then
the `MISE_DATA_DIR` install layout) and refuses closed when no approved Node is
found.

`/ce-tunnel migrate` repairs an already-saved, canonical CE-generated profile in
place (not arbitrarily reformatted YAML): it drops the two rejected `admin_ui`
keys and repoints the MCP child node to the approved Node,
preserving the credential reference, Tunnel ID, Organization ID, binding, Store,
and recipients byte-for-byte. It runs atomically (temp + rename) under the same
ownership lock as setup/start, refuses when the daemon is running or ownership
is uncertain, and never reads, outputs, or copies the API key.


## ChatGPT ↔ Pi messaging integration (MESSAGING-INTEGRATION-01)

Setup's **Advanced · Messaging (ChatGPT ↔ Pi)** authorizes one explicit
bidirectional messaging relationship for the **current Pi session only**:

- The Tunnel MCP binding models the **ChatGPT-side endpoint** (`chatgpt/main`),
  never a `pi` adapter identity, with exactly one authorized recipient — the Pi
  endpoint (`pi/main`). Payload read and ACK are enabled on both sides; every
  other recipient stays refused (fail closed).
- Pi configuration is an immutable sidecar of the selected binding generation:
  `.ce-bindings/messaging-<digest>.yaml.pi-allowlist.json`. Its current Pi
  session id comes from the trusted runtime API, never paths/logs or a guessed
  value. The binding and sidecar select exactly the **same Store directory and
  filename, Exchange namespace and idempotency key**. No SQLite/history copying
  or cross-Exchange router is involved.
- Both immutable files are published with no-overwrite links under the existing
  ownership lock; changing the pair/session selects a new generation. Only the
  existing guarded profile rename activates a complete pair. A precommit failure
  leaves the old profile selecting the old pair. Unreferenced generations and
  staging files are deliberately retained rather than risking deletion of a
  foreign replacement. This is not a crash-atomic multi-file transaction. The
  loader validates the digest and complete pair before loading it; unrelated
  user allowlists and old Store history are never replaced.
- Existing profiles migrate through **Keep credential** plus explicit messaging
  authorization; no key is re-entered, read or copied. A changed authorized
  session needs explicit replacement consent; identity/recipient changes require
  reauthorization rather than silently reducing the pair to a generic binding.
- **Configured != Pi-bound != Connected != real Gate evidence.** After saving:
  1. If an old Pi binding is held by this instance and the policy changed, use
     **Activate current session** (Advanced Messaging or `/ce-tunnel activate`)
     to explicitly release it for policy reload. UNKNOWN release stops here.
     A verified end appends only the old runtime/mapping identifiers as
     `ce-messaging-released`; it carries no capability and cannot grant target
     authority. If release was skipped before reload, the old mapping remains
     an activation denial until its exact released+detached proof is available.
     Reload, an expired lease, a different endpoint or a changed Exchange cannot
     manufacture that proof. Missing/mismatched proof and persistence failures
     refuse; no automatic cleanup/recovery is attempted.
  2. Reload this Pi session/extension to load the selected policy. Ordinary
     reload remains **resume-only**: missing or old-Exchange mapping cannot
     silently provision a new session.
  3. With the Tunnel stopped, select **Activate current session** and confirm the
     actual endpoints, runtime session, full Store/Exchange and permissions.
     This uses the existing Host `beginSession(..., {requireUnowned:true})`,
     appends identifiers only, and never takes over an existing owner, even if
     expired. A valid matching binding is a no-op. Mapping persistence failure
     or uncertain lifecycle outcome stays latched, not blindly retried.
  4. Explicitly restart the Tunnel (Stop then Start) to load its selected MCP
     binding. No activation step starts/stops the Tunnel automatically.
  Actual C2/C3 still require the current ChatGPT session's real tools. The
  Manager Details and Advanced/Review show configuration separately from runtime.
- Pi must run the approved **Node v24.21.0** for Store activation. A different
  Pi process runtime is refused by the existing Store contract; no global Node
  setting or runtime guard is changed by Setup.
- The Pi extension registers `ce_ack` only on exact `ack.enabled: true`; it
  delegates to the existing CE Host receipt operation (reception, not completion).
  Explicit `CE_ALLOWLIST` is preserved. For explicit/generated Store policy,
  `CE_STORE_DIR`/`CE_STORE_FILE` may only exactly match it; skew refuses before
  any Store/session work. Conflicting operator configuration is not overwritten
  or silently ignored. Reload never substitutes a different policy in place.
- ACK only proves reception. `DELIVERY_UNKNOWN != CANCELLED`; delivery is not
  assumed exactly-once; UNKNOWN results are never blindly retried.

## Status and limits

Manager and direct status read the same profile projection and measured runtime
state, but render it differently. Both show a terminal-sanitized profile path and the masked
Tunnel ID, organization
configured or not configured, binding validity, credential configured or not
configured, and a closed refusal code when applicable; direct status renders the
profile path inline while the Manager keeps it in Details. **Direct status
additionally separates Configuration State from
Runtime state.** The Manager is a self-drawn `ctx.ui.custom` panel: a closed
border whose every row is exactly as wide as the real terminal (shrinking instead
of wrapping), a theme-coloured primary state row, and `Configuration` /
`Runtime` sections. It renders a single fused state row, where a
measured `STOPPED` is replaced by `● Not configured` / `● Configuration incomplete`
when the profile itself is unusable; it never upgrades that row toward a connected claim. The
terminal-sanitized profile path, the health evidence, the raw refusal code and
the transport caveats live in the Manager's internal **Details** view (an
in-component view, never a second component ownership), so they never dominate
the operator's decision. Credential contents and credential reference/path are never
status display fields. `UNKNOWN` configuration must not be presented as runtime
`STOPPED`; **Configured != Connected**. Invalid profile-path environment values are
refused before they can reach a TUI or notification.
Masking and avoiding transcript-facing APIs are not process isolation:

- JavaScript strings cannot be reliably zeroized.
- Malicious same-process extensions are outside the component's isolation boundary.
- External terminal recording, clipboard managers, memory dumps, and process-level
  observation are not guarantees this component can provide.

These limitations are accepted for Local Dogfood. Tests use isolated temporary
fixtures, not the operator's real profile/key. Kit's public `createTuiHarness`
checks interaction contracts but is not proof of a physical terminal's fullscreen,
mouse protocol, or theme behavior; reports must distinguish these evidence types.
