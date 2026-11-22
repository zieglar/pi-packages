# Bidirectional notification probe harness

The harness records transport, MCP, client notification, and automatic wake-up as separate evidence layers. It does not send messages itself, poll a client, restart services, or authorize retries.

The default command is a non-sending dry run:

```sh
pnpm probe:notifications
```

Prepare one explicitly authorized observation run and save its private evidence file:

```sh
pnpm probe:notifications pi-to-chatgpt \
  --endpoint chatgpt/test \
  --authorize-send \
  --evidence /private/path/run.json
```

The command prints a single `READY` line with the run ID, nonce, endpoint, and direction. Send exactly one message containing that nonce through the existing CE interface. Do not retry an unknown result.

Record one observed layer in a JSON file, then append it:

```json
{
  "direction": "pi-to-chatgpt",
  "sentAt": "2026-11-16T00:00:00.000Z",
  "messageId": "msg_example",
  "delivery": "DELIVERED",
  "tunnelObserved": true,
  "mcpObserved": true,
  "clientObserved": false,
  "wakeConfirmed": false
}
```

```sh
pnpm probe:notifications --evidence /private/path/run.json --record /private/path/observation.json
```

Verdicts are deliberately strict: Store/transport evidence can reach `TRANSPORT_PASS`; MCP receipt can reach `MCP_PASS`; only a real visible client change reaches `CLIENT_OBSERVED`; only an unsolicited tool invocation reaches `WAKE_CONFIRMED`. Missing client evidence remains `UNVERIFIED`.
