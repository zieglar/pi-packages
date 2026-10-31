---
name: ce-hook-script
description: Use when configuring a local Pi Chat Exchange message Hook or writing a metadata-only notification script for ChatGPT to Pi or Pi to ChatGPT messages.
---

# Local CE Hook scripts

Read the package's [Hook contract](../../docs/hooks.md) in a source checkout before adapting a script. In an installed package, use the contract below. Use the bundled [Python stdlib example](examples/file-notification.py); it requires a POSIX Python 3 interpreter supporting `O_NOFOLLOW`. It performs no network requests and does not invoke CE, ACK messages, or change task state.

## Choose the sending process

Hooks run after a new Message and Payload successfully commit to Store, without waiting for Endpoint delivery or ACK. Configure the process that sends the message:

| Direction | Local configuration owning the rule | Exact recipient |
| --- | --- | --- |
| ChatGPT → Pi | Sender MCP binding configuration, top-level `hooks` | `{ "adapter": "pi", "endpointId": "pi/main" }` |
| Pi → ChatGPT | Sender Pi explicit `CE_ALLOWLIST` file or legacy allowlist, top-level `hooks` | `{ "adapter": "chatgpt", "endpointId": "chatgpt/main" }` |

Replace sample Endpoint IDs with the actual complete recipient identity. The currently selected multi-session profile does **not** support Hook rules. Do not add `hooks` to that profile or silently switch configuration modes. Use an operator-controlled supported configuration when appropriate.

## Static local rule

Locate the actual interpreter with `python3 -c 'import sys; print(sys.executable)'`. Resolve the bundled script to its absolute installed path. Prepare an operator-owned private directory (mode 0700) outside Store for notifications. Replace all illustrative paths below with absolute local paths; keep interpreter, script, and output filename fixed in local configuration. Merge this array into the existing supported configuration, preserving its other required fields:

```json
{
  "hooks": [
    {
      "id": "pi-file-notification",
      "event": "ce.message.committed.v1",
      "recipient": { "adapter": "pi", "endpointId": "pi/main" },
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/skills/ce-hook-script/examples/file-notification.py", "/absolute/private/notifications.jsonl"],
      "timeoutMs": 30000,
      "enabled": true
    }
  ]
}
```

For Pi → ChatGPT, use the same static command and args in the Pi allowlist, with a distinct rule ID and `recipient` exactly `{ "adapter": "chatgpt", "endpointId": "chatgpt/main" }`. Matching requires both event and complete recipient. Timeout accepts 1000–60000 ms. CE directly spawns the interpreter with `shell:false`; never interpolate remote content or metadata into paths, arguments, or shell code. Remote messages cannot select commands.

## stdin contract

The runner supplies one UTF-8 JSON document followed by EOF, with exactly these top-level fields:

```text
schemaVersion,event,eventId,eventKey,messageId,exchangeId,sender,recipient,createdAt,payloadDigest,payloadLength
```

`schemaVersion` is 1; `event` is `ce.message.committed.v1`. Sender and recipient contain exactly `adapter` and `endpointId`. IDs and `createdAt` are strings; `payloadDigest` is the original Payload's SHA-256 hex digest; `payloadLength` is its UTF-8 byte length. There is no payloadText, session, capability, or invented correlation field. Hook configuration grants no payload-read authority.

The example bounds input to 16384 bytes, rejects duplicate/unknown fields and invalid metadata, and appends one JSON line containing exactly the validated envelope. It never derives the output path from stdin. Output must be a private regular file owned by the operator, with one hard link; symlinks and special files are refused. Keep ancestor directories trusted. Existing contents are preserved. Success is silent; failure exits 1 with only `notification rejected` on stderr.

## Audit and failure handling

Pi `/ce-hooks` displays the **loaded snapshot**, including configuration source, fixed command/args, recipient and active/configured counts. It does not reread disk edits. Reload the owning process/configuration through its normal lifecycle to apply changes. MCP reports sanitized counts on stderr.

Execution records are `<store.directory>/ce-hooks/executions.jsonl`. The runner ignores child stdout/stderr. Failures, timeouts, queue overflow and shutdown skips do not change delivery, ACK, task completion, or the committed send result. There is no automatic retry, startup replay, or exactly-once guarantee. Do not replay side-effecting scripts after a missing final record or timeout: a notification may already have been written. This example is a notification sink, not a durable task queue or deduplication mechanism.
