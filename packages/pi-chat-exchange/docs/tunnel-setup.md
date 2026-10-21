# Local Tunnel setup and Manager

`/ce-tunnel` is the interactive entry point. Direct `setup`, `status`, `start`,
`stop`, and `help` subcommands remain shortcuts. Configuration is not connectivity:
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

First setup collects Tunnel ID, optional Organization ID, an explicitly selected
existing MCP binding JSON path, and a key. The review shows only nonsecret
configuration and credential intent. Only final Save enters the transaction.
Existing-profile editing preserves the binding and offers Keep existing
credential / Replace credential. Keeping a credential does not read its content.
Identity or binding changes require an additional old-to-new review/confirmation.
Escape, Cancel, interaction timeout, or disposal of a nonsecret Kit page resolves
as `CANCELLED` before Save; the wrapper drains Kit's pending handler barrier and
does not write profile, credential, or Keychain. Starting is always a separate
explicit action.
## Binding selection is static validation, not authority acquisition

No historical binding or Store is automatically selected. Binding validation reads
only the chosen ordinary nonsymlink configuration file and uses the formal MCP
binding parser. It does not open/create the configured Store, bind an endpoint,
read/ACK/send a message, launch a child, or establish a network connection.

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

## Status and limits

Manager and direct status read the same profile projection and measured runtime
state, but render it differently. Both show a terminal-sanitized profile path,
masked Tunnel ID, organization configured or not configured, binding validity,
credential configured or not configured, and a closed refusal code when
applicable. **Direct status additionally separates Configuration State from
Runtime state.** The Manager screen renders a single fused state row, where a
measured `STOPPED` is replaced by `UNCONFIGURED`/`ERROR` when the profile itself
is unusable; it never upgrades that row toward a connected claim. Credential contents and credential reference/path are never
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
