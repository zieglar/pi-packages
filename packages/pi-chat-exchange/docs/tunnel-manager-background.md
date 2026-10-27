# Tunnel manager — real background scope (LOCAL-BACKGROUND-01)

This document describes the **real background** mode of `/ce-tunnel start|status|stop`.
The offline simulator mode (`CE_TUNNEL_OFFLINE_TEST=1`, see `tunnel-manager-offline.md`)
is unchanged. There is exactly one manager per extension host; the two modes never
run side by side.

## What it does

- Starts the operator-managed real client as a **detached daemon**:
  `tunnel-client run --profile-file <profile>` (default profile
  `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`, override with `CE_TUNNEL_PROFILE`).
  The daemon survives the Pi session by design.
- Persists an ownership record at `<profileDir>/background-state.json` (0600,
  atomic tmp+rename): run id, pid, profile path **and** sha256, tunnel id, key
  file path, health url file, log path, the exact `ps` command line and the exact
  `ps` start-time key observed right after spawn, start/stop bookkeeping.
- Health comes only from real probes: `tunnel-client health --url-file …
  --pid <owned> --require-control-plane-poll --json`, parsed by the frozen
  `health.ts` rules and stamped once per completion by the shared recorder.
  PID liveness alone is never CONNECTED.
- Background startup has a **45s** default window, measured from run allocation:
  the external client 0.0.16 defaults to a 30s initial long-poll plus a 5s
  deadline guardrail, with 10s allowance for startup, probes and scheduling.
  These are external defaults, not dynamically synchronized configuration.
  The shared offline simulator retains its 30s window; explicit timing overrides
  remain authoritative. Required-poll readiness and verified cleanup are unchanged;
  no automatic restart or post-deadline recovery is introduced.
- Status vocabulary: `STOPPED / STARTING / CONNECTED / DEGRADED / UNKNOWN`.
  Stale evidence lapses to UNKNOWN on read; a pure read never refreshes state.

## Hard limits

- **Explicit real-start gate.** `/ce-tunnel start` refuses
  `CE_TUNNEL_BACKGROUND_UNAUTHORIZED` unless the operator exported exactly
  `CE_TUNNEL_BACKGROUND_ALLOW=1` for this Pi session. `status`/`stop` are not
  gated: they never create cost, and stop only reduces it.
- **Cross-process exclusion.** Start/stop (and any refresh that needs to
  persist) hold `<state>.lock.d` — a mkdir DIRECTORY lock whose holder is
  verified by pid + start key. Stale or crashed locks are reclaimed under
  mutual exclusion between reclaimers: rename-to-grave first, then the grave's
  holder is verified to be the SAME lock that was judged stale; a mismatch
  rolls the rename back and refuses `CE_TUNNEL_MANAGER_BUSY`. A holderless
  lock younger than 60s refuses. Critical sections re-assert lock ownership
  before any persist/signal. The record is re-read inside the lock, so two Pi
  sessions cannot double-start or double-signal.
- **Termination ledger.** A recorded run is signalled only after its
  `termRequestedAt` intent persists; without the ledger the signal is refused
  and ownership retained. A run whose record could never persist is guarded by
  an in-memory once-set (a crash loses the record and the guard together);
  neither disk ENOENT nor a different run's stopped record ever discards such
  pending ownership.
- **Stop latency.** `stop` first awaits the settlement of any start it
  invalidated (bounded by one probe timeout + identity capture + the stop
  grace), then takes the lock; it never returns while a cancelled start still
  owns work.
- **Dual-run stop.** If a session also owns an unpersisted (pending) daemon
  whose run differs from the on-disk record, `stop` terminates BOTH — the
  pending run via its in-memory once-set (at most one signal ever), the disk
  run via its ledger. If the pending run still has not exited, `stop` refuses
  `CE_TUNNEL_STOP_UNCONFIRMED` and the status note says to run stop again; it
  never reports success while a run it owns is still alive.
- **Ledger write guards.** Every `persist()` is machine-enforced to a held lock
  token, refuses a corrupt on-disk record, and refuses to overwrite a DIFFERENT
  run's live record — no code path can roll back another session's ownership or
  termination ledger. Lock reclaim verifies the grave's inode, mtime and holder
  token all match the judged-stale lock before deletion.
- **Three-state inspection.** Process checks are present / proven-absent /
  unknown (`/bin/ps`, fixed minimal env, LC_ALL=C). Unknown retains ownership
  and blocks start; it is never treated as exit proof.
- **Fail-closed record.** Only a missing file means "no record"; a corrupt or
  unreadable one is `CE_TUNNEL_STATE_CORRUPT` and blocks start/stop.

- **No credential interaction.** The key reaches the client only via the
  profile's existing `file:` reference. The manager checks the key file by
  metadata only (regular, non-symlink, owner-only 0600 — `profile.ts`
  `checkKeyFileRequirements`). Inline values and `env:` references refuse
  `CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED`.
- **Organization context (LOCAL-BACKGROUND-05).** The optional profile field
  `control_plane.organization_id` is a double-quoted, escape-free scalar with
  local grammar `org-[A-Za-z0-9]{1,128}`. This is a bounded syntax policy, not
  proof of server-side organization/Tunnel/Connector binding. Missing fields
  preserve legacy behavior; an organization-scoped Tunnel may still reject
  requests without one. Empty, invalid, repeated (even identical) fields and
  extra-header overrides are refused before spawn.
  The client reads the unchanged explicit `--profile-file` itself. Version
  0.0.16 advertises organization ID as the `OpenAI-Organization` request header
  and precedence flags > environment > YAML > defaults. Manager spawn adds no
  organization flags and retains its existing minimal environment whitelist:
  parent `CONTROL_PLANE_*`, `OPENAI_*` and `TUNNEL_CLIENT_*` overrides are not
  forwarded. Thus the explicit profile is the only organization input here.
  For example, add `organization_id: "org-Example123"` under `control_plane`
  (two-space indentation) after confirming the target's non-secret metadata.
  Existing profiles are never automatically migrated: changing a historical
  Tunnel ID or adding organization context requires explicit operator approval.
  No live authentication or real-Tunnel readiness is implied by local parsing.
- **PID reuse safety.** Every later status/stop re-verifies BOTH the exact
  command line and the exact process start key. A mismatch reports UNKNOWN /
  refuses `CE_TUNNEL_EXTERNAL_INSTANCE`; nothing is adopted or signalled.
- **Wrapper exec identity (LOCAL-BACKGROUND-03).** Homebrew installs the
  client as a shim script (`#!/bin/bash` plus `exec "<Cellar libexec>" "$@"`),
  so ps shows `/bin/bash <shim> run …` before the exec and `<cellar> run …`
  after it — same pid, same start key. At spawn time the manager reads the
  client file once and derives the acceptable identity set from explicit
  evidence only: the direct argv always; the `<interpreter> <shim>` form only
  from a no-argument `#!/abs/path` shebang; the post-exec form only from a
  single strict `exec "<abs>" "$@"` line whose target is absolute, normalized,
  printable, and an existing regular file. The exec form is persisted on the
  record (`commandIdentityExec`) so later sessions recognize the exec'd
  process. The exec form additionally requires the WHOLE file to be the
  canonical shim shape (shebang + exactly one strict exec line; other lines
  only blank or comments) — heredoc bodies, indented exec lines, or extra
  statements forfeit it. Anything unknown or ambiguous (relative/unquoted/
  multi-exec lines, missing target, oversized or unreadable shim) yields no
  form and stays fail closed. Basename equality, pidfiles, and process names
  are never evidence. A non-canonical wrapper (extra statements, heredocs, an
  unreadable or oversized script) therefore DEGRADES to unmanageable after its
  exec — identity mismatch, UNKNOWN, `CE_TUNNEL_STOP_UNCONFIRMED` — and the
  instance is never mis-signalled; recovery is the documented manual,
  identity-verified termination. Identity capture itself also accepts only the
  evidence-derived identity set, so a client whose file cannot be read yields
  an unconfirmed (pending) run rather than a substring-matched one.
- **Pending-run PID-reuse bar (S-1/F1).** A spawn whose identity was never
  captured (identity-pending, memory-only) keeps its child handle: the handle's
  exit event is first-class proof that OUR spawn died, after which any process
  at that pid is a foreign reuser. The proof is archived PER RUN ID (runIds are
  UUIDs and never reused), the listener is armed before the identity-capture
  window, and a later start never resets another run's evidence — so the
  dual-run stop path cannot sever it; dispose() likewise keeps the proof while
  a pending run survives, because stop/refresh stay callable after dispose.
  Such a run is then closed as exited and
  is NEVER adopted or signalled — re-acquisition requires a live child link
  plus exact membership in the evidence-derived identity set. Stop notes
  distinguish "exit observed after SIGTERM" from "exit observed (process
  already gone); no signal sent". On-disk `null` values for optional record
  fields (`commandIdentityExec`, `termRequestedAt`) are normalized to absent
  at load, so a foreign null can neither forge an identity nor suppress a
  termination signal. A pending run whose process is gone is superseded
  directly (`identityPending` stripped before persist), so a later start does
  not fail with a misleading `CE_TUNNEL_STATE_CORRUPT`.
- **One SIGTERM per run, ever.** `termRequestedAt` is persisted, so even a
  later Pi session never re-signals. Timeout refuses
  `CE_TUNNEL_STOP_UNCONFIRMED` and **retains** the record. No SIGKILL, no bulk
  kill, no name-based signalling (scans only REFUSE a duplicate start).
  **Write-ahead window:** if a record-backed run's `termRequestedAt` persisted
  but the signal was lost (e.g. the lock was taken before `signal()`), that
  run is deliberately NOT re-signalled — at-most-once forbids the retry, so
  at-most-once permits **zero** deliveries here. A later `stop` from this
  manager will NOT re-signal that record (its intent is already ledgered); it
  only ever reports `CE_TUNNEL_STOP_UNCONFIRMED` while the process survives.
  There is no automatic recovery: the operator must separately authorise a
  manual, identity-verified termination of the surviving process — never clear
  the ledger to bypass the at-most-once guard.
- **No autostart, reconnect, respawn, or business retry.** A vanished daemon is
  marked stopped with `process absent (unexpected)`; restart is a fresh,
  explicit `/ce-tunnel start`.
- **The MCP child is never signalled by this manager.** After the client's exit
  is verified, a lingering profile-declared `mcp-stdio.js` child is only
  reported (`note`), because that child belongs to the client.
- Session teardown (`shutdown`, `session_start`, reload) never stops the
  background daemon; it only drops this host's view.
- Transport state is never delivery, ACK, reconciliation, or completion
  evidence; MCP reachable does not imply any message was delivered.

## Cost / authorization

The first real background run is a paid connection: it still requires a separate
operator authorization of cost and window, plus the `CE_TUNNEL_BACKGROUND_ALLOW=1`
opt-in. This command is the manual trigger; there is no unattended path.
