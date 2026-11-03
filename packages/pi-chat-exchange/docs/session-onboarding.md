# Connect a new Pi session

This candidate continues HANDOFF-CE-SESSION-ONBOARDING-01. The installed `0.3.1-daily.1` is unchanged until a separately validated installation update. Published CE 0.3.0 Hooks and existing registrations remain supported.

In a new interactive Pi session, run:

```text
/ce-tunnel connect
```

For a session without a registration, Connect offers an independent generated Endpoint. The preview shows the Endpoint, peer, Store, Exchange and grants. Endpoint names do not use the project path or session display name. You do not enter a Session ID or Endpoint name. New registrations default to metadata access and the configured ChatGPT peer; payload reading, reception ACK and Hooks are disabled. Existing Session grants are not copied.

Accepting the registration publishes its policy. Connect invokes Pi 1.3.0's supported command reload API, then the new extension runtime rechecks the selected policy and continues the connection flow. It asks for persistent background startup permission when needed and asks for current-session activation. Cancel any confirmation to stop before the next stage. A saved registration may remain if a later activation or permission confirmation is cancelled; a later Connect reuses that registration.

A repeated Connect reuses the registration and active binding. It does not create another Endpoint. The generated label is derived from the trusted native Session ID using SHA-256, not from a path or display name. A revoked registration requires explicit operator reauthorization; Connect does not silently reactivate it.

Use `/ce-status` for local binding and lease evidence, and `/ce-tunnel status` for transport health. These do not prove recipient reads, reception ACK or task completion. Hooks stay disabled for a new registration until separately configured and loaded. Existing configured Hooks retain their lifecycle and deny-only revocation checks.

## Shared Tunnel limitation

A session that is already registered and active can reuse an existing compatible managed Tunnel. A new Endpoint cannot join the currently running MCP child under the current architecture: MCP captures its recipient grants at startup and only narrows them afterward. Registration publication and new activation also use the existing verified-STOPPED configuration lock.

Connect does not stop a shared Tunnel. It reports the actual registration or activation constraint and asks the operator to coordinate Stop before another Connect. Other Sessions' Owners and history are not removed. This candidate therefore does not satisfy the full goal of admitting any new Session into a running shared Tunnel without Stop/Start. It does not bypass those locks or change MCP's loaded-grant authority to disguise that limitation.

If official reload fails, the registration remains available. Repeating Connect can retry the supported lifecycle transition; it must not republish an existing registration. A reload continuation is consumed before confirmation and is limited to the same native Session, Profile, configuration revision and runtime environment. It is a request for fresh admission checks, not a durable permission or recovery token.

## Diagnostics

- Current session is not registered: Connect offers a new independent registration when supported by the selected multi-session profile.
- Endpoint policy is not loaded: Connect uses the official reload API. A context without that API refuses with a concrete instruction.
- Activation requires confirmation: cancellation creates no active binding or transport.
- Shared Tunnel is running with an incompatible configuration: coordinate a shared Stop; Connect never stops it on your behalf.
- Endpoint is owned by another session: no takeover or automatic cleanup. Inspect ownership and close the owner normally.
- Profile, policy or session changed during confirmation: the stale operation refuses. Run Connect again to review the current target.

Legacy explicit `CE_ALLOWLIST` configurations retain their existing behavior. Connect does not silently convert or replace them. The low-level register/activate/deactivate commands remain available for explicit administration.
