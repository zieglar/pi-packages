# Tunnel manager — offline scope (HOST-09 B1.1)

This document covers the **explicit offline harness** retained from HOST-09 B1.1:
masked capture, scoped Keychain CRUD, and an owned offline simulator lifecycle.
It is not the current real-profile setup guide. For the Kit Setup Wizard and
persistent Manager, see [`tunnel-setup.md`](tunnel-setup.md). Synthetic setup and
Keychain authorization are reachable only with `CE_TUNNEL_OFFLINE_TEST=1`.

## What is implemented

| Area | Module | Scope |
|---|---|---|
| Masked credential capture | `src/tunnel/secure-input.ts` | `ui.custom` component, TUI only |
| Keychain CRUD | `src/tunnel/keychain.ts` + `native/tunnel-keychain.swift` | one exact item per validated scope |
| Offline simulator | `src/tunnel/offline-client.ts` | fake client, no socket, no credential |
| Owned lifecycle | `src/tunnel/manager.ts` | start/stop/status of that simulator only |
| Commands and status | `packages/pi-chat-exchange/pi-extension/index.ts` | `/ce-tunnel setup\|authorize\|start\|stop\|status\|help` |

## Hard limits

- **This simulator cannot start a real client.** Its credential hand-off remains
  blocked. The separate real-background Manager's **real start** requires the
  exact `CE_TUNNEL_BACKGROUND_ALLOW=1` gate and a validated real profile
  (status/setup/stop create no connection and run gate-free); see the real setup
  guide. No plaintext key is placed in child argv or environment.
- **The simulator needs an explicit opt-in**: `CE_TUNNEL_OFFLINE_TEST=1`
  (exact string). Without it, the extension selects the separate real-background
  Manager; it does not silently enable simulator credential behavior.
- **No autostart, no restart, no auto-respawn.** An unexpected exit — including
  exit code 0 — becomes `Error` and requires an explicit `start`.
- **Only the owned child is ever signalled.** No PID is adopted from disk, a
  lock file, or a process list; there is no `adopt`/`attach` API.
- **At most one SIGTERM request per run; no SIGKILL or blind signal retry.**
  Timeout refuses `CE_TUNNEL_STOP_UNCONFIRMED` and retains the owned handle.
  Repeated stop/dispose waits for that same child's actual exit without sending
  another signal. The legacy `killTimeoutMs` option does not enable escalation.
- **A ChildProcess `error` event is not exit proof.** It is also emitted when a
  signal could not be delivered while the process is still alive, so the pid
  stays owned, the status reports `Error`/unconfirmed, and `stop()` awaits an
  actual `exit`/`close`. Error protection is attached immediately on acquisition,
  including no-PID spawn failures, and remains through late/duplicate events.
  A no-PID child is never adopted or signalled; a valid owned child is never
  replaced merely because of an error event.
- **Health records need a strictly increasing integer `sequence`.** A duplicate,
  replayed, missing, non-integer, or non-positive sequence is refused **before**
  any completion is stamped, so it can never refresh an expired state. Records
  must also be explicitly labelled `simulated: true` and must belong to the live
  owned run and PID; a record arriving after the owned child exited mutates
  nothing.
- `setup` writes to the **synthetic offline scope only**
  (`https://offline-b11.invalid` + `tunnel_b11offline`). It never reads an
  existing production profile, config, or key.
- `authorize` (B1.1-INTEGRATION) is the only user-triggered native macOS
  keychain authorization path. It performs ONE interactive read of the stored
  synthetic credential — the macOS prompt appears, and the operator personally
  chooses Allow (this read only), Always Allow (this exact helper build may
  read unattended — until the helper's CODE IDENTITY changes; a plain
  deterministic recompile keeps the identity), or Deny/Cancel (nothing
  changes). A follow-up noninteractive read reports which state was chosen.
  The credential value is discarded unseen; only closed codes are surfaced
  (`CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED`, `CE_TUNNEL_KEYCHAIN_USER_CANCELED`).

## Status segments

Three independent keys; none is evidence for another:

| Key | Meaning |
|---|---|
| `ce` | CE runtime binding for this session. Never manufactured when CE is unavailable. |
| `ce-tunnel` | Offline/simulated transport state, always suffixed `(offline simulated)`. |
| `ce-client` | `simulated activity observed this run` only after an **actual attributed** simulator record; otherwise `no activity observed this run`. |

Transport state is never delivery, ACK, reconciliation, or completion
 evidence. No segment claims a client is online: absence of activity is
 reported as "not observed", never as "offline".

Status is a **read-only freshness projection**: reads can display expiry or
`Unknown`, but cannot reset/advance recovery counters, stamp a health completion,
refresh evidence, or change run identity. M distinct healthy completions can
recover a disconnected run even with status reads between them.

Transport teardown (shutdown/reload/session_start) awaits the owned child's
actual exit **or a bounded unconfirmed-stop refusal**, even when CE is disabled
or CE release fails. Overlapping teardowns join one release. Manager `dispose()`
rejects on unconfirmed stop. The extension records that refusal rather than
throwing it into CE cleanup, **retains** the manager and blocks replacement;
subsequent teardown waits for the same child without re-signalling. Only actual
exit/close permits successful disposal and replacement. The closed code
`CE_TUNNEL_STOP_UNCONFIRMED` is reported on the next `/ce-tunnel` call. CE
release/fencing authority is untouched.

## Credential capture properties

- Requires `ctx.mode === "tui"` **and** an available `ui.custom`. `hasUI` is
  insufficient (it is also true in RPC). Non-TUI refuses
  `CE_TUNNEL_INPUT_UNAVAILABLE` and never degrades to a plaintext path.
- Bounded single-line **visible ASCII** (no space, control byte, or non-ASCII),
  max 512 characters. Bracketed paste is validated **atomically**: an invalid
  paste is rejected whole, and a pasted newline never submits.
- The secret goes to exactly one sink, the Keychain writer. It never reaches
  `ui.input`, the main editor, `pasteToEditor`, `notify`, `sendMessage`,
  `appendEntry`, a log, or the returned outcome.
- One idempotent finish for submit / Escape / Ctrl-C / timeout / external abort
  / dispose. `ui.custom` has no built-in abort or timeout, so both are
  implemented here. **Dispose is itself an outcome**: an externally disposed
  component settles the capture as `cancelled/aborted` exactly once, so a
  session teardown can never leave the caller awaiting forever. A runtime that
  disposes re-entrantly from inside `done` cannot produce a second finish.
- **Masking is not memory erasure.** JavaScript strings are immutable, so
  complete zeroization is not claimed. Terminal paste buffers, crash dumps,
  terminal recording, and same-user process access remain separate exposure
  surfaces.

## Keychain properties

- Fixed service `pi-chat-exchange-tunnel`; account is
  `v1:sha256(origin + NUL + tunnelId)` from a validated canonical scope.
- Fixed operation allowlist (`exists`/`read`/`create`/`update`/`delete`), exact
  class + service + account, one resolved keychain, exact item reference for
  update/delete. No enumeration, prefix, service-wide, or search-list fallback.
- `create` installs an **explicit empty** trusted-application list (the
  documented equivalent of `security -T ""`); `nil` (creator trust) and
  allow-all (`-A`) are never used. `read`/`update` **refuse** a broader ACL
  rather than adopting or repairing it, and the ACL is validated **before** the
  secret is requested: the exact item is first resolved metadata-only, then
  checked, and only then is `SecKeychainItemCopyContent` called on that exact
  item reference. Partition lists are untouched and no OS prompt is automated.
- ACL validation **fails closed**: an access object that cannot be copied, an
  ACL list that is absent or empty, an authorization list that is unreadable, or
  an application list that is `nil` ("all applications") all refuse
  (`acl_too_broad`). An empty trusted-application list is restrictive only on an
  ACL that actually covers secret-reading authorizations.
- The secret crosses process boundaries only as **framed stdin**. It never
  appears in argv, the environment, compiler arguments, a file, or a shell
  string. Raw stdout/stderr is never forwarded; only closed `CE_TUNNEL_*` codes
  escape. The helper reads fd 0 through one reader with a **bounded header scan**
  (≤ 96 bytes) and an **exact-length payload read** — no `readLine` (stdio
  buffering would desynchronise fd 0) and no `readDataToEndOfFile` (it would
  allocate before the length bound is known). Trailing bytes after the declared
  frame are a protocol violation.
- Native `errSecItemNotFound` (-25300) is the only accepted "missing" signal.
  The `security(1)` CLI's exit 44 convention is deliberately not honoured.
- An ambiguous timeout is **never retried**: the mutation may already have
  committed, so the exact item must be reconciled first.
- Compilation is **serialized**: concurrent operations share one compile and one
  owner-only temporary directory. A `dispose()` during a compile awaits and
  releases the in-flight artifact instead of leaking the directory; artifacts are
  released exactly once.

### Probe keychain targeting (test/probe only)

By default the helper resolves the **default** keychain inside the process, and
production behaviour is unchanged. An explicitly constructed test runner may
instead name exactly ONE keychain file, which the helper opens with
`SecKeychainOpen` and probes with `SecKeychainGetStatus`:

```ts
createNativeKeychainRunner({ probeKeychainPath: "/tmp/b11-probe/owned.keychain" })
```

This exists so the authorized probe can target an exclusively owned temporary
keychain **without mutating the default keychain or any search list**. Neither
`SecKeychainSetDefault` nor `SecKeychainSetSearchList` is ever called. The path
is accepted **only** as that construction option — never from the environment, a
CE command, a profile, or a `KeychainRequest` (any `keychainPath` field on a
request is structurally ignored). It must be absolute, single-line, NUL-free,
space-free, and ≤ 1024 bytes, or the operation refuses
`CE_TUNNEL_KEYCHAIN_UNAVAILABLE` before spawning the helper. Since B2-P2 (S2-04
removal) the TS runner accepts ONLY `v1:<sha256 hex>` accounts — the former
`b11-probe:` grammar is refused with `CE_TUNNEL_KEYCHAIN_UNAVAILABLE`;
unrelated items are never read.

### Native helper request frame

```text
stdin:  "v1 <op> <accountBytes> <secretBytes>[ <keychainPathBytes>][ interactive]\n"
        + <account bytes> + <secret bytes> + <keychain path bytes>
op   ∈  exists | read | create | update | delete
service = "pi-chat-exchange-tunnel"   (compiled in, never an input)
account = v1:<sha256 hex>   (b11-probe grammar removed in B2-P2; refused by the runner)
```

Without `probeKeychainPath` the header has exactly four fields and the frame
carries account (and secret for `create`/`update`) only. With it, a fifth field
and trailing path bytes are appended. B1.1-INTEGRATION adds one optional
TRAILING literal token `interactive` — allowed on `read` only, after the
optional probe-length field (six-field form `v1 read <a> <s> <k> interactive`),
producing the user-paced native authorization read; the token is never a
number, so the five-field form stays unambiguous. `stdout` is exactly one JSON line:
`{"status":"ok"}` | `{"status":"ok","secretBase64":"…"}` |
`{"status":"not_found"}` |
`{"status":"error","reason":"bad_request|unavailable|acl_too_broad|already_exists|authorization_required|user_canceled"}`.
`authorization_required` is the native -25293 class (no user decision for THIS
code identity); `user_canceled` is the -128 class (the operator dismissed the
native prompt). The UPDATE policy is stricter than the READ policy: `update`
accepts only the pristine empty-list state (a non-empty read trusted list is
refused with `acl_too_broad`), so rotation after Always Allow requires
delete + create + one new authorization.

Round-3 hardening (Lane S S-R2-01): `update` also requires every ACL that
carries a ChangeACL or Any authorization to have an explicitly empty,
non-nil trusted-application list, with at least one governance ACL present.
An item whose read list is empty but whose
separate ChangeACL ACL already names some program is refused: that program
could admit itself to the read list unattended after receiving the newly
typed secret. Missing or unreadable governance state fails closed, and the
helper never adopts, repairs, or recreates such an item.

## Verification and remaining limits (B1.1)

- The Swift helper compiles with legacy-API deprecation warnings. A parent-run
  probe exercised the production adapter against two unique synthetic accounts
  in an exclusively owned temporary Keychain: create, metadata existence, update,
  exact deletion and account isolation passed. Actual ACL metadata showed an
  empty trusted-application list for secret-reading authorizations. A deliberately
  broad ACL on an owned fake item was refused for read and update.
- **Historical note:** the statement below was B1.1-FIX's boundary; B1.1-KEYCHAIN-GATE and B1.1-INTEGRATION have since verified real successful reads under the restrictive ACL via the user-approved path.
- **Successful Keychain retrieval remains NOT VERIFIED.** Reads of the restrictive
  items returned `CE_TUNNEL_KEYCHAIN_UNAVAILABLE`; no successful value comparison
  was possible. No ACL was relaxed, helper trust granted, or OS prompt approved to
  make this pass. Update success alone does not prove the resulting secret value.
  This is not a complete successful CRUD claim or B2 readiness.
- The parent exercised the actual installed Pi 1.3.0 TUI and production component
  in a network-denied PTY with an isolated agent directory and persisted Session
  JSONL. Submit used a synthetic in-memory writer; cancel, Ctrl-C, timeout, dispose,
  abort, writer rejection and non-TUI refusal were observed. Raw output, output
  logs and decoded session strings contained no full/long-fragment/encoded
  synthetic canary. This does **not** prove end-to-end real-Keychain setup success,
  universal terminal/clipboard safety, or memory zeroization.
- The production extension's help, setup cancellation and explicitly opted-in
  bundled simulator start/status/stop were exercised with CE disabled. No real
  client, provider request, control plane, delivery, ACK or completion was tested.
- Detailed immutable evidence and the final acceptance decision live in the
  external HANDOFF-CE-HOST-09-TUNNEL-MANAGEMENT B1.1 report; these bounded results
  do not authorize real credential hand-off or any B2 execution.
