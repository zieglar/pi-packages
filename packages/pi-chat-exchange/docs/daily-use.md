[English](daily-use.md) | [简体中文](daily-use.zh-CN.md)

# Restore a configured CE session

This guide covers daily connect/disconnect and persistent startup authorization (HANDOFF-CE-PERSISTENT-AUTH-01). Load an extension containing these changes first: editing this checkout does not update installed CE 0.3.0. Repository metadata remains the historical 0.2.2 candidate; this change does not bump versions, publish, or replace the installed package.

## Configure once

1. Follow the [Tunnel guide](tunnel-setup.md) to select the existing legitimate profile, Store, Exchange, Tunnel and credential reference. Existing configuration need not be recreated. For initial selection of a nondefault profile, explicitly select its normalized absolute path with `CE_TUNNEL_PROFILE`; a confirmed grant then remembers the selected profile and trusted client for later plain `pi` launches. Load only one CE extension.
2. Start Pi with approved Node and your existing model and extension configuration. Use `/name` for a recognizable session name and `/session` to verify identity. Existing `pi/main` belongs to its registered native Pi session: restore that session instead of registering `pi/main` from a new one.
3. Only an unregistered native session needs [multi-session registration](multi-session-usage.md): explicitly Stop and verify STOPPED, then `/ce-tunnel register pi/your-explicit-unique-name`. Confirm the current session, Store, Exchange and permissions. Add `--payload-read` or `--ack` only when required. Legacy single-session configurations remain supported; convert explicitly only when multiple sessions are needed. Do not recreate the Exchange to bypass registration checks.
4. After configuration publication, `/reload` to load the selected policy. An initial reload without a mapping, or a normally ended binding, can report `CE_HOST_MAPPING_INVALID`. Explicit connect requests legitimate activation without discarding history or taking over an Owner.
5. Run `/ce-tunnel connect` in the interactive TUI. Without valid permission, it asks you to confirm the selected profile, client, credential reference access, possible cost and background lifetime before activation or startup. Cancel/refusal leaves no new grant, activation or spawned client. `/ce-tunnel start` also requests permission when needed. Confirming stores permission and the chosen profile/client; later ordinary `pi` launches need no shell alias, shell configuration or `CE_TUNNEL_BACKGROUND_ALLOW`.

Keep your approved runtime, model and extension configuration. Permission allows explicit startup only; it does not autostart or register a new native session. See [persistent permission](tunnel-manager-background.md#persistent-startup-permission) for scope and safety rules.

## Daily use

From the original project directory, run ordinary `pi` and select the **same registered session** in Pi's picker. Then:

```text
/ce-tunnel connect
/ce-tunnel status
```

Connect checks interactive TUI, persistent startup permission, Native/runtime admission and loaded configuration identity. It retains a valid binding; when a new CE incarnation is needed it reuses explicit activation confirmation, the STOPPED configuration lock and `requireUnowned`. Only then does it start the existing profile or measure an already running instance. It does not create another Tunnel, session mechanism or message manager.

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

Open `/ce-tunnel` without arguments for the existing state-aware Manager. Alongside setup/start/stop, it offers Connect, Disconnect, Status and Manage Permission. The Permission submenu shows the current state, View Status, applicable Grant Permission / Revoke Permission actions and Back. These reuse the command confirmations; revocation does not stop a running Tunnel. All permission subcommands remain available.

Interactive `/ce-status` and `/ce-tunnel status` show a separate bottom `Esc  Close` row with the key in the active theme accent. Short terminals prioritize this row over status content. Esc, the configured cancel key and Ctrl-C close the screen; status admission and notification fallback are unchanged.

To leave other sessions' shared transport running, normally exit Pi or explicitly deactivate. On restoration, fresh activation while that Tunnel is still running requires an operator-coordinated explicit Stop before connect. Connect never silently interrupts the shared instance. Manual Stop can interrupt an in-flight connect; there is no automatic reconnect or background retry.

## Refusals and remaining cost

- `CE_TUNNEL_BACKGROUND_UNAUTHORIZED`: inspect `/ce-tunnel permission status`. Explicitly confirm through connect or `/ce-tunnel permission grant` for an absent, revoked or changed grant. Invalid storage requires manual inspection; do not delete or auto-repair it. Reentering a credential does not fix permission.
- Session absent from allowlist: select the registered session, or explicitly register a unique endpoint for a new native session. No endpoint guessing, reassignment or treating an old ID as permission for any new session.
- Unloaded policy or changed profile/environment: explicitly reload and verify identity; the old factory cannot expand grants.
- Fresh activation with running or unknown transport: inspect status, coordinate an explicit Stop, verify STOPPED, then connect.
- Busy, expired Owner, uncertain mutex/release: stop that restoration path and follow [troubleshooting](tunnel-setup.md) with exact evidence. No automatic takeover, Owner deletion or marker cleanup.
- Binding succeeds but transport start fails: retain the established binding and report the transport failure. Inspect status before a new explicit action; no automatic unbind, Tunnel recreation or retry.

Persistent authorization supersedes the earlier external-launcher workaround. Restore the same registered native session and confirm activation when required; remembered profile/client paths do not authorize an arbitrary new session to use `pi/main`.

Isolated regressions exercise real Host/SQLite/policy with controlled process, Native-qualification and transport boundaries. Persistent authorization is also checked across independent Node processes using an isolated OS-account home and production executable selection; no client is executed by that check. Desktop-tool regressions do not establish real desktop or cloud acceptance. Real Pi TUI restart, cloud, desktop, production and long-duration operation remain unverified; no boot startup, unattended reconnect or business task recovery is promised.
