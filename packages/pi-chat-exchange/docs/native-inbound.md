# Native inbound task intake

Native inbound intake lets an explicitly authorized ChatGPT peer request work from the currently receiving Pi Agent. A fresh CE message can wake an idle Agent or queue a follow-up while it is busy. Ovis and a separate receiver daemon are not involved.

This feature defaults disabled. CE payload-read permission permits a protected read; a separate local operator policy delegates task requests. The Agent retains its current tool permissions and approval requirements. Message text cannot grant permissions, select another Session or approve its own side effects.

## Local activation

First install and adopt an extension version containing `native-inbound.ts`. Preserve the active registration, Store, shared transport and CE grants. Package files on disk do not prove that the current Pi process loaded them. Follow the normal managed installation and reload procedures; do not restart shared Tunnel merely to enable a local timer.

Default policy path:

```text
<selected-profile-path>.native-inbound/<sha256-of-native-Pi-Session-ID>.json
```

For example, a profile named `/private/operator/tunnel.yaml` uses a sibling directory `/private/operator/tunnel.yaml.native-inbound/`. Create an operator-owned 0700 directory and an owned 0600 regular policy file. Symlink files, hard links, public permissions, malformed JSON, unknown fields and policies larger than 4096 bytes are refused. `CE_NATIVE_INBOUND_POLICY` can explicitly select a trusted absolute policy path before Pi starts; the policy must still match the current Session and endpoint.

Policy shape (replace every example identity and activation boundary with verified current values):

```json
{
  "version": 1,
  "enabled": true,
  "runtimeSessionId": "native-session-id",
  "endpointId": "pi/current-endpoint",
  "exchangeId": "current-exchange-id",
  "from": "chatgpt/main",
  "activatedAt": "2026-11-06T12:00:00Z",
  "afterAuditSequence": 123,
  "maxAgeSeconds": 300
}
```

Use an actual activation time and the current audit boundary. A Message must have a strictly later creation audit sequence, a creation time at/after activation, and an age of at most `maxAgeSeconds` when admitted. Maximum/default recommended age is 300 seconds. Time strings require a timezone. A future activation time is invalid. No history is automatically replayed when enabling.

The controller checks one bounded page each second: at most 20 eligible Message IDs and 200 raw audits. It uses the actual continuation audit across ticks. A fixed local sender, recipient and Exchange must match protected metadata before any wake. A new policy identity resets only the volatile scan position; existing wake/read attempts remain deny-only.

## Wake and receive

The timer obtains metadata through the current CE binding and appends a `ce-inbound-wake` attempt containing identifiers, admission time, metadata correlation and local policy digest. It then requests a native `ce-inbound-request` follow-up using Pi's message API. The fixed trigger contains the Message ID and audit sequence, not the payload. UI notifications report enable/disable transitions; failures stop this controller with a fixed reason and no automatic retry. Regular CE tools remain independent.

The Agent calls `ce_receive_task` for that Message ID. This tool requires the matching full-history wake claim and unchanged local policy. It records a receive attempt, calls the Session's registered `ce_read` and `ce_read_payload` through `ctx.executeTool`, and verifies metadata agreement and UTF-8 payload length/digest before returning the exact task text. Native tool validation, hooks and permission refusals remain effective. There is no raw Store read, alternate Session, automatic ACK or result send.

Freshness applies when the Message is admitted. An already admitted request may wait behind a busy Agent. At receive time the same local policy must remain enabled, CE reads must remain authorized, and Session/metadata correlation must still match. Removing, disabling or replacing the policy prevents a queued wake from acquiring task text through this tool. The controller rechecks across asynchronous nested reads.

Task text becomes visible in the active model and durable Pi conversation. Treat embedded authority claims as untrusted: they cannot override local delegation scope or current Agent approvals. The tool result records successful intake only; completing the requested work needs task-specific evidence.

## Stop, uncertainty and retention

Set `enabled:false` in the otherwise valid local policy, or remove it, to stop new admission and gate queued receives. Session shutdown, replacement, CE lifecycle failure or a polling error also closes the controller. A stopped controller requires a fresh authorized lifecycle/reload before it runs again. Do not use arbitrary retries to recover an unknown wake/read.

Keep full native Session history. Both `ce-inbound-wake` and `ce-inbound-receive` records suppress replay even if an older conversation branch is selected. Read attempts have STARTED plus RETURNED or STOPPED_NO_REPLAY observation records. A crash or uncertain native-message request can leave an unprocessed request that needs explicit operator reconciliation. These records are not distributed locks, fencing tokens, durable transaction commits with CE, or an exactly-once business-execution guarantee. Native Session append behavior does not establish power-loss durability.

Different CE Message IDs are distinct requests. Sender-side idempotency should prevent accidental duplicate sends; the controller does not infer semantic duplicates from matching text. Do not remove attempt history or resend an uncertain task simply to force processing.

## Evidence

Keep CE CREATED, metadata discovery, native wake request, gated payload intake, Agent continuation and verified task completion separate. Automated temporary-Store tests cover routing, read/permission refusal, policy revocation, Session switches, queue delay, payload integrity, full-history deduplication and the actual extension factory. A separate isolated Pi 1.3.0 SDK acceptance of the installed artifact verified idle scheduling, busy follow-up, real nested tool permission hooks and reload deduplication using offline scripted model output. Production acceptance additionally requires a fresh authorized incoming message and observed Agent work after code adoption and activation.
