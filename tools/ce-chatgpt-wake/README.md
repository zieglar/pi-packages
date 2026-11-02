# CE ChatGPT wake

A test-only macOS CLI integration: Pi creates a CE message, then sends one fixed desktop notice to one explicitly selected ChatGPT conversation. ChatGPT must read the actual CE Payload and reply through CE. Pi reads, verifies and ACKs the reply before the next round. CE ACKs remain reception evidence, never proof of task completion.

Requires the installed Pi1.3.0/CE0.3.0 modules, Node24.21.0, Python3.11+, agent-desktop1.0.2/JSON2.5, existing Tunnel/ChatGPT connection and production Native cache. Reuses `../ce-ovis-desktop` transport, journals and bounded cleanup; no CE core/configuration change. Semantic Accessibility set-value/click only; no headed fallback, clipboard or permission bypass.

## Runtime installation and coexistence

Use a dedicated common prefix for the exact runtime versions; do not build or import CE from this checkout (its core package remains the historical 0.2.2 candidate):

```sh
npm install --prefix /absolute/private/runtime @zieglar/pi-chat-exchange@0.3.0 @earendil-works/pi-coding-agent@1.3.0
```

Set `modules` to `/absolute/private/runtime/node_modules`. Install the official Tunnel Client separately and qualify its exact version; the accepted Cloud runs used Client 0.0.19 on macOS arm64. Pin agent-desktop 1.0.2 / JSON 2.5 and provide a trusted Native 0.1.0 cache in the isolated HOME. These scripts use internal Pi SDK and CE module paths pinned to those versions; newer releases require a fresh compatibility review.

The supervisor refuses any existing `tunnel-client run` process. It temporarily uses the existing Cloud identity through an isolated profile/Store; it cannot run alongside the normal receiver on that identity. Before a separately authorized E2E window, normally stop the owned transport and verify STOPPED. Keep it stopped until the test supervisor confirms cleanup, then restore the normal receiver through its normal activation/start workflow. No new Tunnel or MCP connection is needed. Loading or reloading the coordinating Pi extension does not itself authorize a desktop window or run these scripts.

Keep operator configuration and evidence in private0700 directories. `wake.py --config DESKTOP.json --record CREATED.json` accepts only `{testId,messageId,to,replyTo,disposition}` with `disposition:CREATED`. No Payload is accepted. The fixed notice includes only identifiers and instructions to read CE tools. A private per-Message-ID journal is persisted before input and submit. Existing journals return without desktop action, including UNKNOWN outcomes; do not delete them to retry.

Desktop config fields: `agentDesktop`, exclusive `desktopTmpDir`, `desktopSession`, `windowId`, `pid`, `processInstance`, `windowTitle`, `conversationMarker`, `stateDir`, `maxWaitSeconds`, `pollSeconds`. Use fresh `list-windows --app ChatGPT` and scoped snapshots to determine identity. The driver requires one matching webarea, the conversation marker and exact input/send names. Empty placeholder text is normalized; any draft or busy ChatGPT blocks a new notice. After submit the send button may become Stop; submitted text plus cleared input is the notice evidence. Never infer processing success from the desktop result.

For end-to-end testing, `peer.mjs CONFIG.json` uses real Pi Session extension tools. Config adds `modules`, `runDirectory`, `isolatedHome`, `existingProfile`, `node`, `python`, `client`, `endpointId`, `testId`, `deadline`, `bridge` (wake.py), `desktopConfig` and exactly two `rounds:[{testId,nonce}]`. Existing `ce-ovis-desktop/ce-peer.mjs prepare CONFIG.json` prepares a fresh isolated Store/registration/native Session using the existing Cloud identity; provide legacy placeholder taskFile/taskPayloadSha256 fields for its startup allowlist. No new Tunnel or connection is created.

Run `python3 tools/ce-chatgpt-wake/supervise.py CONFIG.json`. It waits for actual Pi tool admission and control-plane poll health, then records READY. Create `runDirectory/start-request` only when the locked ChatGPT conversation is idle. Peer records send-attempt before calling real ce_send. Only CREATED permits wake. A failed/unknown notice stops the sequence; no send/wake retry. A successful notice is followed by polling the real CE Inbox, exact nonce/testId/inReplyTo reply validation and reception ACK. A completed file requires both rounds. User must not manually send an extra reminder during acceptance.

Stop via `runDirectory/stop-request` or deadline (at most15minutes). Supervisor owns and cleans only its process groups and exclusive desktop namespace. Uncertain host startup yields CLEANUP_UNCONFIRMED. Never resume an ended native Session: prepare a fresh run directory. Raw snapshots/logs/Store/credential references stay outside Git; public summaries retain only necessary outcomes and correlation.

Tests:

```sh
python3 -m unittest discover -s tools/ce-chatgpt-wake -v
node --test tools/ce-chatgpt-wake/*.test.mjs
```

A UI notice observed, ChatGPT processing indicator, CE send/ACK and validated reply are separate states. No ACCEPT without actual automatic ChatGPT tool-read/reply in two rounds. No unattended business automation or exactly-once guarantee.

The accepted real two-round run preceded the final exact-marker and supervisor evidence checks. Those changes were verified with saved snapshots and controlled local process fixtures, not another Cloud run. This integration review adds stop/ACK and supervisor interruption regressions; it does not extend the recorded Cloud or desktop-version coverage. Local process tests isolate the unrelated global Client inventory while exercising owned process cleanup; they do not probe or stop the user's live Client.
