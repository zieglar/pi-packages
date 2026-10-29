[English](multi-session-usage.md) | [简体中文](multi-session-usage.zh-CN.md)

<a id="一个-tunnel多个项目与-pi-session"></a>

# One Tunnel, multiple projects and Pi Sessions

Each real Pi Session uses a separate, stable Endpoint, such as `pi/project-A` or `pi/project-B`. A project directory is not an identity. Multiple Sessions in one project must each register separately. On the ChatGPT side, `chatgpt/main` is an explicitly shared inbox; it does not isolate ChatGPT conversations.

Complete the [initial Tunnel setup](tunnel-setup.md) first. The configuration operations below do not send, read or ACK messages, and do not automatically start or stop the Tunnel.

<a id="1-从单-session-显式转换"></a>

## 1. Explicitly convert a single-session configuration

An existing single-session configuration remains usable. Convert when you need multiple Sessions:

1. Explicitly run `/ce-tunnel stop` and verify transport is **STOPPED**. ACTIVE/UNKNOWN refuses conversion; conversion does not Stop automatically.
2. Close all old legacy Pi bindings/runtimes, or update them and release their bindings normally. New revocation gates cannot constrain old binaries, so a new configuration alone does not revoke them.
3. In the old current Session, `/ce-tunnel deactivate` can confirm normal unbinding without exiting Pi, deleting history or stopping transport. If release is unknown, stop the procedure; do not “clean up” the Owner.
4. From an **unbound** interactive TUI, run `/ce-tunnel convert`. Acknowledge the old-runtime limitation and check that the original registration, Store, Exchange and grants are retained. Conversion refuses while a legacy binding is still held locally.

Conversion creates no new broad default permissions and does not automatically bind the retained legacy registration.

<a id="2-在每个真实-session-注册-endpoint"></a>

## 2. Register an Endpoint in each real Session

Run this from the Pi Session you want to authorize. Its Endpoint must differ from those of other Sessions:

```text
/ce-tunnel register pi/project-B --payload-read --ack
```

- Registration accepts only the current trusted native Pi Session, not a manually supplied Session ID. Binding still requires reload followed by explicit activation.
- `--payload-read` and `--ack` are independently optional and both default to **off**. Do not enable them simply to copy the example.
- Before confirming, check the Endpoint, current Session, Store, Exchange and permissions.
- register/revoke/convert require verified STOPPED transport. They do not Stop/Start for you or require re-entry of the original credential.

For different projects, load the same extension and select the same profile. Initializing separate Stores in each project does not provide automatic routing. An explicitly nonempty `CE_ALLOWLIST` retains legacy precedence and blocks generated-policy registration/conversion.

<a id="3-分别加载与激活"></a>

## 3. Load and activate each Session

```text
/reload
/ce-tunnel activate
/ce-status
```

A first registration has no CE mapping, so reload may refuse with `CE_HOST_MAPPING_INVALID`. Explicitly activate and confirm afterward to create that Session's binding with requireUnowned. This is not recovery and never takes over an existing Owner, including an expired Owner.

Pi grants are captured when the factory loads. Save/register does not expand the old runtime's permissions automatically. The MCP child also needs a separate explicit `/ce-tunnel start` after the earlier Stop to read the selected generation. Pi reload does not reload the remote MCP child.

In `/ce-status`, the native Pi Session is a lookup; the CE Session is an Owner incarnation. Endpoint is the stable message label, and Participant is the participant in the Exchange. lease/fencing describes current authority, not transport health. **Configured ≠ Pi-bound ≠ Connected ≠ message evidence.**

<a id="4-找到可用收件人"></a>

## 4. Find available recipients

In the currently bound, authorized multi-session runtime:

```text
/ce-tunnel sessions
```

This lists the exact active Endpoint IDs in the selected configuration for use as `ce_send.to`. Admission still checks the current runtime, loaded registration epoch, current policy and process mutex. Unbound, unloaded, revoked, stale or uncertain states refuse rather than list other targets.

The list does not read the Inbox, prove the MCP child has loaded, or prove receipt of a message. `to` takes neither a native/CE Session ID nor an extra adapter prefix. ChatGPT still shares its own history/inbox; the operator must explicitly choose the recipient Endpoint for each message.

<a id="5-区分解绑撤销停止与-reload"></a>

## 5. Distinguish unbinding, revocation, Stop and reload

| Operation | What changes | What it does not do |
|---|---|---|
| `/ce-tunnel deactivate` | After confirmation, normally releases the current local CE Owner, detaches and stops renewal | Does not revoke registration, delete history, Stop the Tunnel or end other Sessions |
| `/ce-tunnel revoke pi/project-B` | After confirmation, revokes future admission for one exact stable registration; requires STOPPED | Does not roll back admitted operations, automatically release the durable Owner or delete messages |
| `/ce-tunnel stop` | Stops a transport instance whose ownership the Manager can prove | Does not prove the Pi Owner was released or registration revoked |
| `/reload` with a valid binding | Stops/drains the old generation, revalidates and resumes the original durable mapping | Creates no extra Owner and performs no automatic takeover |
| `/reload` in a released/unbound Session | Loads policy without automatically rebinding | Rebinding requires explicit activation; reload cannot revive an ended CE Session |

Cancelling deactivate retains the binding; repeated calls do not repeat end. If release/end or evidence persistence is unknown, the runtime remains fail-closed. Absence of a local handle is not proof of safe release. Normal exit/Session replacement also follows normal end. Normal end/release bypasses deny-only revocation checks so authority can be returned safely.

Revocation blocks only newly admitted operations, including reads/renew. Already admitted operations may finish. Other registrations and shared ChatGPT history remain. Reauthorization uses a fresh epoch; old handles still refuse. Do not delete old registrations/Owners/Stores to “reset” them.

<a id="安全与恢复限制"></a>

## Safety and recovery limits

The process guard provides local exclusion only, not CE authority or crash recovery. An old registration epoch cannot reuse a reload handoff. Uncertain cleanup retains the marker and failure latch. Append-only records can accumulate without automatic collection; a dead process does not trigger automatic takeover. Recovery requires separate authorization and verification of exact durable evidence.

This page enables no automatic Inbox polling, payload execution, ACK, retry or Wake Bridge. Real messages and ACKs still require authorization each time. Local configuration/isolated tests do not replace real user acceptance. See the [Pi tool guide](../pi-extension/README.md) and [troubleshooting](tunnel-setup.md#故障排查先定位层再进行最小修复).
