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
| Pi → ChatGPT (multi-session) | Selected `ce-multi-session-v1` manifest, the sending Session's `registrations[]` item, optional `hooks` | Exactly `manifest.chatgptEndpoint` |

Replace sample Endpoint IDs with the actual complete recipient identity. In multi-session mode, MCP → Pi rules remain in binding `hooks` and must target active registered Pi Endpoints. Pi projects only the selected Session registration's rules. There is no global manifest `hooks` field or new permission; absence remains backward compatible. Do not silently switch configuration modes.

## Static local rule

Locate the actual interpreter with `python3 -c 'import sys; print(sys.executable)'`. Resolve the bundled script to its absolute installed path. Prepare an operator-owned private directory (mode 0700) outside Store for notifications. Replace all illustrative paths below with absolute local paths; keep interpreter, script, and output filename fixed in local configuration. Use this fragment in operator-controlled authoring inputs, preserving all other required fields. For multi-session Pi, place the array on the relevant manifest registration. MCP binding and manifest are separate digest-paired files in an immutable generation: prepare inputs offline and publish through the existing operator-authorized controlled generation path. Never edit production content-addressed files in place. There is no automatic migration or new Hook CLI; `/ce-tunnel convert` and `/ce-tunnel register` have no flags for adding Hooks:

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

For Pi → ChatGPT, use the same static command and args in the Pi allowlist or corresponding multi-session manifest registration, with a distinct rule ID and the actual ChatGPT recipient (exactly `manifest.chatgptEndpoint` in multi-session mode). Matching requires both event and complete recipient. Timeout accepts 1000–60000 ms. CE directly spawns the interpreter with `shell:false`; never interpolate remote content or metadata into paths, arguments, or shell code. Remote messages cannot select commands.

## stdin contract

The runner supplies one UTF-8 JSON document followed by EOF, with exactly these top-level fields:

```text
schemaVersion,event,eventId,eventKey,messageId,exchangeId,sender,recipient,createdAt,payloadDigest,payloadLength
```

`schemaVersion` is 1; `event` is `ce.message.committed.v1`. Sender and recipient contain exactly `adapter` and `endpointId`. IDs and `createdAt` are strings; `payloadDigest` is the original Payload's SHA-256 hex digest; `payloadLength` is its UTF-8 byte length. There is no payloadText, session, capability, or invented correlation field. Hook configuration grants no payload-read authority.

The example bounds input to 16384 bytes, rejects duplicate/unknown fields and invalid metadata, and appends one JSON line containing exactly the validated envelope. It never derives the output path from stdin. Output must be a private regular file owned by the operator, with one hard link; symlinks and special files are refused. Keep ancestor directories trusted. Existing contents are preserved. Success is silent; failure exits 1 with only `notification rejected` on stderr.

## Audit and failure handling

Pi `/ce-hooks` displays the **loaded rules**, including configuration source, fixed command/args and recipient. `configured` counts loaded rules; in multi-session mode `active` counts the effective current subset, with source `selected multi-session profile registration`. Only identical enabled static rules in both loaded and current policy remain effective, with matching registration identity, Endpoint and epoch, and active status in both. MCP rules additionally require an admitted registered recipient. Current policy can narrow the loaded snapshot but cannot expand it; additions or changed rules require reloading the owning process/configuration through its normal lifecycle. MCP reports sanitized counts on stderr.

An optional runner admission gate checks current policy before each child starts, including queued work. Denial records `SKIPPED_POLICY_DENIED` without spawning; already running children are not cancelled by this check.

Execution records are `<store.directory>/ce-hooks/executions.jsonl`. The runner ignores child stdout/stderr. Failures, timeouts, queue overflow and shutdown skips do not change delivery, ACK, task completion, or the committed send result. There is no automatic retry, startup replay, or exactly-once guarantee. Do not replay side-effecting scripts after a missing final record or timeout: a notification may already have been written. This example is a notification sink, not a durable task queue or deduplication mechanism.
