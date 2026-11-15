# CE command surface and native inbound activation design

## Goal

Make `/ce` the single user-facing entry point while retaining hidden compatibility
commands, and add an explicit, safe way to activate native inbound intake for the
current Pi Session. This change does not alter message semantics, Store schema,
authorization, ownership, or Tunnel lifecycle.

## Command surface

The visible command tree is:

```text
/ce
/ce status
/ce setup
/ce session bind|unbind|list
/ce inbound status|enable|disable
/ce advanced transport|native|hooks|bindings|maintenance
```

`/ce` with no arguments shows the consolidated status and opens the existing
interactive manager where UI is available. Subcommands delegate to existing
Tunnel, Native, Hook, runtime-binding, registration and activation handlers.
The legacy `/ce-status`, `/ce-tunnel`, `/ce-native`, `/ce-hooks`, and `/ce-bind`
commands remain registered for compatibility, but their descriptions and
completion behavior no longer advertise them as parallel ordinary entry points.

`session bind` uses the existing current-Session registration/activation flow;
`session unbind` uses the existing live-safe deactivation flow; `session list`
uses the existing live Session listing. It must not translate live operations to
legacy transport-stopping behavior.

## Consolidated status

The status view composes existing read-only observations for the native Pi
Session, CE Session and Owner, Tunnel lifecycle, Native readiness, native
inbound policy, and MCP runtime source. Every field has an explicit evidence
source. A field that cannot be observed safely is rendered `UNKNOWN`; absence
of evidence is never reported as healthy, stopped, or disabled.

The help text and UI descriptions reflect actual live behavior:

- live `connect` may bind or resume the current Session while retaining a
  running shared Tunnel;
- live `disconnect` releases only the current Session and retains the shared
  Tunnel;
- live `register` publishes current-Session policy and does not itself start or
  stop the Tunnel.

Legacy behavior remains described separately where it differs.

## Native inbound policy management

`/ce inbound status` resolves the current Session-specific default policy path,
validates the file with the existing policy reader, and reports enabled,
disabled, unavailable, or invalid without creating state.

`/ce inbound enable --from <sender>` requires a real TUI and confirmation. It
captures the current native Session ID, admitted Endpoint and Exchange, and the
current Exchange audit high-water before confirmation. After confirmation it
revalidates all captured authority and configuration facts, then writes a v1
policy with:

- the explicitly supplied sender;
- the verified current Session, Endpoint and Exchange;
- `activatedAt` set to the current timestamp;
- `afterAuditSequence` set to the observed current high-water;
- `maxAgeSeconds` set to 300.

The parent directory is operator-owned mode `0700`. The policy is an
operator-owned regular file of mode `0600`, written through a same-directory
temporary file, synced, renamed atomically and then revalidated. Symlinks,
hardlinks, unsafe permissions, unknown fields and identity drift fail closed.
The command never copies another Session's policy and never lowers the audit
boundary, so messages 395/396 and all earlier history are excluded.

`/ce inbound disable` requires TUI confirmation and revalidates the same current
Session identity. It atomically rewrites only that Session's valid policy with
`enabled:false`. It does not delete wake/receive history, change CE Owner state,
modify grants, ACK messages, or stop the Tunnel.

Reload is explicit and local to Pi. A successful policy write reports that the
operator must reload before the controller lifecycle changes; it never restarts
Tunnel or MCP.

## Testing and evidence

Targeted tests cover:

1. visible `/ce` routing and completion;
2. legacy command compatibility without duplicate ordinary discovery;
3. live-mode help and descriptions;
4. consolidated status with verified and `UNKNOWN` fields;
5. inbound enable validation, confirmation, atomic permissions and audit
   boundary;
6. disable without deletion or Owner mutation;
7. reload adoption and no duplicate native inbound controller;
8. fresh-message wake and gated receive through the real extension factory.

Implementation follows red-green-refactor. Production acceptance is separate:
adopt the published package through `pi install npm:@zieglar/pi-chat-exchange@0.3.5`,
remove the manual package source without duplicate loading, create a new Pi
Session, explicitly enable inbound for that Session, and receive one newly sent
message. Evidence must distinguish policy creation, reload, wake, receive and
business handling. The running MCP remains separately identified and is not
changed by Pi package installation.

## Operational boundaries

This task may commit locally. It may not push, merge, release, restart Tunnel or
MCP, reset the startup budget, clean an old Owner, modify credentials, replay
messages 395/396, or reuse an old Session's native inbound policy.
