[English](daily-use.md) | [简体中文](daily-use.zh-CN.md)

# Restore a configured CE session

This guide covers `/ce-tunnel connect` and `/ce-tunnel disconnect` added by HANDOFF-CE-DAILY-UX-01. Load an extension containing this change first: editing this checkout does not update installed CE 0.3.0. Repository metadata remains the historical 0.2.2 candidate; this change does not bump versions, publish, or replace the installed package.

## Configure once

1. Follow the [Tunnel guide](tunnel-setup.md) to select the existing legitimate profile, Store, Exchange, Tunnel and credential reference. Existing configuration need not be recreated. For a nondefault profile, explicitly set `CE_TUNNEL_PROFILE` to its normalized absolute file path in the external parent environment. Load only one CE extension.
2. Start Pi with approved Node and your existing model and extension configuration. Use `/name` for a recognizable session name and `/session` to verify identity. Existing `pi/main` belongs to its registered native Pi session: restore that session instead of registering `pi/main` from a new one.
3. Only an unregistered native session needs [multi-session registration](multi-session-usage.md): explicitly Stop and verify STOPPED, then `/ce-tunnel register pi/your-explicit-unique-name`. Confirm the current session, Store, Exchange and permissions. Add `--payload-read` or `--ack` only when required. Legacy single-session configurations remain supported; convert explicitly only when multiple sessions are needed. Do not recreate the Exchange to bypass registration checks.
4. After configuration publication, `/reload` to load the selected policy. An initial reload without a mapping, or a normally ended binding, can report `CE_HOST_MAPPING_INVALID`. Explicit connect requests legitimate activation without discarding history or taking over an Owner.
5. Once, add this function to an external shell configuration you control. It supplies the existing permission to a newly started parent Pi process; it neither starts Tunnel nor persists a new CE permission or credential.

```sh
cepi() {
  CE_TUNNEL_BACKGROUND_ALLOW=1 pi --resume
}
```

This example assumes `pi` already selects your approved installed runtime. If you normally use an approved Node command or dedicated Pi launcher, keep that invocation and prefix it with the variable. Do not change global Node, model or extension sources for this example. Set your own nondefault `CE_TUNNEL_PROFILE` explicitly in the function when needed; never load it automatically from project files. To withdraw this daily launch permission, remove the function or its variable and normally exit already authorized Pi processes.

Permission remains an exact `"1"` in each parent Pi process. Exporting in a Pi child shell or running `/reload` cannot grant the missing parent permission. No persistent CE authorization file, configuration boolean or autostart is introduced.

## Daily use

From the original project directory, run `cepi` externally and select the **same registered session** in Pi's picker. Then:

```text
/ce-tunnel connect
/ce-tunnel status
```

Connect checks interactive TUI, exact process permission, Native/runtime admission and loaded configuration identity. It retains a valid binding; when a new CE incarnation is needed it reuses explicit activation confirmation, the STOPPED configuration lock and `requireUnowned`. Only then does it start the existing profile or measure an already running instance. It does not create another Tunnel, session mechanism or message manager.

Status separates CE binding from measured transport health. It does not check model availability or authorize business execution; transport health is not delivery, ACK or completion. The Manager screen is a snapshot: use Refresh or `/ce-tunnel status` for a fresh measurement.

To end this communication window:

```text
/ce-tunnel disconnect
```

Confirm the stated scope: release this Pi's local CE binding and stop the **selected profile's shared Tunnel**, potentially interrupting other sessions' transport. Their Owners, registrations and history remain. After confirmation, current CE admission closes before normal release and Manager Stop are awaited independently. An uncertain phase reports `disconnect incomplete`, retains failure evidence and never reports overall success or reopens admission. Already admitted operations may finish; committed messages and external effects cannot be recalled. A Manager note about a remaining MCP child means Tunnel exit does not prove every component has stopped.

Normally exit Pi afterward. Next time, restore the same native session and connect without registering again or creating an Exchange. Normal exit ends its CE Owner; later activation can create a new CE incarnation. It does not reuse an old CE Session ID indefinitely.

## Existing command behavior

| Command | Scope |
|---|---|
| `connect` | Validate this session's existing registration/binding, confirm activation if needed, then explicitly start or inspect transport |
| `disconnect` | Confirm normal release of this binding and stop shared transport |
| `start` / `stop` | Existing transport lifecycle only; Stop alone does not release the local CE Owner or close all local CE tools |
| `activate` / `deactivate` | Existing explicit binding/release, without automatic transport changes |
| `status` / `/ce-status` | Transport/Native measurements versus current CE binding and lease |

To leave other sessions' shared transport running, normally exit Pi or explicitly deactivate. On restoration, fresh activation while that Tunnel is still running requires an operator-coordinated explicit Stop before connect. Connect never silently interrupts the shared instance. Manual Stop can interrupt an in-flight connect; there is no automatic reconnect or background retry.

## Refusals and remaining cost

- `CE_TUNNEL_BACKGROUND_UNAUTHORIZED`: exit normally and restore through the external launcher; reentering a credential does not help.
- Session absent from allowlist: select the registered session, or explicitly register a unique endpoint for a new native session. No endpoint guessing, reassignment or treating an old ID as permission for any new session.
- Unloaded policy or changed profile/environment: explicitly reload and verify identity; the old factory cannot expand grants.
- Fresh activation with running or unknown transport: inspect status, coordinate an explicit Stop, verify STOPPED, then connect.
- Busy, expired Owner, uncertain mutex/release: stop that restoration path and follow [troubleshooting](tunnel-setup.md) with exact evidence. No automatic takeover, Owner deletion or marker cleanup.
- Binding succeeds but transport start fails: retain the established binding and report the transport failure. Inspect status before a new explicit action; no automatic unbind, Tunnel recreation or retry.

The design follows the **ACCEPT WITH FOLLOW-UP** route: preserve the process gate, avoid typing the variable repeatedly through a user-controlled launcher, and reduce daily CE operations to connect. Session selection and necessary activation confirmation remain. Reusing an endpoint from an arbitrary new native session and persistent authorization inside CE require separate design.

Isolated regressions exercise real Host/SQLite/policy with controlled process, Native-qualification and transport boundaries. Desktop-tool regressions do not establish real desktop or cloud acceptance. This change does not install a production update, run Cloud E2E or verify long-duration operation; it promises no boot startup, unattended reconnect or business task recovery.
