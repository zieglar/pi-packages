# Shared Tunnel: multiple Pi Sessions

Configuration only; not real Tunnel/ChatGPT acceptance evidence. Each real Pi
Session needs its own stable Endpoint. `chatgpt/main` is a consciously shared
inbox, **not conversation isolation**. No automatic inbox polling, payload
execution or ACK is enabled by this mode.

1. Keep existing single-session setup as-is, or explicitly opt in. Stop the
   Tunnel with `/ce-tunnel stop`. Before conversion, close every legacy Pi
   binding/runtime (or update and reload it). Old binaries cannot be revoked by
   the new gates. From an **unbound** TUI Pi Session, run `/ce-tunnel convert`;
   acknowledge the legacy-runtime limitation, then confirm preservation of the
   existing registration, Store, Exchange and grants. A locally held legacy
   binding prevents conversion. No new first-setup grants are silently created.
2. In each additional real Pi Session, use:
   `/ce-tunnel register pi/project-B --payload-read --ack`
   Substitute a distinct explicit stable Endpoint. Only the current trusted Pi
   Session is registered. Both flags are optional and default **off**; preview
   Store, Exchange and permissions before confirming. ACK is reception only.
3. Reload the Pi extension explicitly (`/reload`). A newly registered runtime
   that has never been bound has no mapping after reload: explicitly run
   `/ce-tunnel activate` and confirm its first binding. If the previous mapping was
   normally ended, use `/ce-tunnel activate` and confirm to create a new binding;
   a live same-process reload instead transfers its closed, drained guard and
   resumes the same durable mapping. Changed registration epochs cannot reuse
   that handoff. No automatic ownership takeover is provided.
4. From a currently bound, authorized multi-session Pi runtime,
   `/ce-tunnel sessions` lists exact **selected configured active** Endpoint IDs
   to copy into `ce_send.to`. Current runtime identity, loaded/current registration
   epoch and process mutex must admit the entire discovery/notification. Unbound,
   unloaded, revoked, stale or uncertain runtimes refuse without enumerating targets.
   It does not inspect inboxes and cannot prove what
   a running MCP child loaded. Use a separate explicit `/ce-tunnel start` after
   Stop to load selected MCP grants. Configured != Pi-bound != Connected.
5. `/ce-tunnel revoke pi/project-B` previews one exact stable Endpoint and asks
   for confirmation. Register/revoke require verified STOPPED transport; running
   or UNKNOWN refuses, with no stop/start side effect or credential re-entry.
   Revocation blocks later new-gated operations, including reads and renewal;
   already admitted operations may finish. Other registrations and shared
   ChatGPT history remain. Regrant uses a fresh epoch; old handles stay denied.

Grants loaded by a Pi factory remain immutable until explicit reload; newly
published grants do not widen an old runtime. Explicit `CE_ALLOWLIST` retains
legacy precedence and blocks conversion/registration commands. Stale dialogs,
changed runtime/environment/revision and unknown selected policy fail closed.

The process guard is local exclusion, not CE authority or crash recovery.
Uncertain cleanup retains its marker and failure latch. There is no automatic
reclamation, even for dead processes; retained append-only records accumulate
and may require separately authorized offline reconciliation. Normal end/release
bypasses deny-only revocation checks so authority can be safely relinquished.
