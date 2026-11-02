# CE ChatGPT wake

A test-only macOS CLI integration: Pi creates a CE message, then sends one fixed desktop notice to one explicitly selected ChatGPT conversation. ChatGPT must read the actual CE Payload and reply through CE. Pi reads, verifies and ACKs the reply before the next round. CE ACKs remain reception evidence, never proof of task completion.

Requires the installed Pi1.3.0/CE0.3.0 modules, Node24.21.0, Python3.11+, agent-desktop1.0.2/JSON2.5, existing Tunnel/ChatGPT connection and production Native cache. Reuses `../ce-ovis-desktop` transport, journals and bounded cleanup; no CE core/configuration change. Semantic Accessibility set-value/click only; no headed fallback, clipboard or permission bypass.

Keep operator configuration and evidence in private0700 directories. `wake.py --config DESKTOP.json --record CREATED.json` accepts only `{testId,messageId,to,replyTo,disposition}` with `disposition:CREATED`. No Payload is accepted. The fixed notice includes only identifiers and instructions to read CE tools. A private per-Message-ID journal is persisted before input and submit. Existing journals return without desktop action, including UNKNOWN outcomes; do not delete them to retry.

Desktop config fields: `agentDesktop`, exclusive `desktopTmpDir`, `desktopSession`, `windowId`, `pid`, `processInstance`, `windowTitle`, `conversationMarker`, `stateDir`, `maxWaitSeconds`, `pollSeconds`. Use fresh `list-windows --app ChatGPT` and scoped snapshots to determine identity. The driver requires one matching webarea, the conversation marker and exact input/send names. Empty placeholder text is normalized; any draft or busy ChatGPT blocks a new notice. After submit the send button may become Stop; submitted text plus cleared input is the notice evidence. Never infer processing success from the desktop result.

For end-to-end testing, `peer.mjs CONFIG.json` uses real Pi Session extension tools. Config adds `modules`, `runDirectory`, `isolatedHome`, `existingProfile`, `node`, `python`, `client`, `endpointId`, `testId`, `deadline`, `bridge` (wake.py), `desktopConfig` and exactly two `rounds:[{testId,nonce}]`. Existing `ce-ovis-desktop/ce-peer.mjs prepare CONFIG.json` prepares a fresh isolated Store/registration/native Session using the existing Cloud identity; provide legacy placeholder taskFile/taskPayloadSha256 fields for its startup allowlist. No new Tunnel or connection is created.

Run `python3 tools/ce-chatgpt-wake/supervise.py CONFIG.json`. It waits for actual Pi tool admission and control-plane poll health, then records READY. Create `runDirectory/start-request` only when the locked ChatGPT conversation is idle. Peer records send-attempt before calling real ce_send. Only CREATED permits wake. A failed/unknown notice stops the sequence; no send/wake retry. A successful notice is followed by polling the real CE Inbox, exact nonce/testId/inReplyTo reply validation and reception ACK. A completed file requires both rounds. User must not manually send an extra reminder during acceptance.

Stop via `runDirectory/stop-request` or deadline (at most15minutes). Supervisor owns and cleans only its process groups and exclusive desktop namespace. Uncertain host startup yields CLEANUP_UNCONFIRMED. Never resume an ended native Session: prepare a fresh run directory. Raw snapshots/logs/Store/credential references stay outside Git; public summaries retain only necessary outcomes and correlation.

Tests:

```sh
python3 -m unittest discover -s tools/ce-chatgpt-wake -v
node --test tools/ce-chatgpt-wake/reply.test.mjs
```

A UI notice observed, ChatGPT processing indicator, CE send/ACK and validated reply are separate states. No ACCEPT without actual automatic ChatGPT tool-read/reply in two rounds. No unattended business automation or exactly-once guarantee.
