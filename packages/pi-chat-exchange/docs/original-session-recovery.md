# Restore the original Pi session

A registered native Pi Session automatically revalidates its own CE binding at startup, resume and reload. Use the original session file:

```sh
pi --session /absolute/path/to/original-session.jsonl
```

There is no separate recover command or restoration confirmation. Conversation branching and compaction do not change the native Session's CE lifecycle: the complete append history determines the latest binding. Creating or forking a native Session changes identity and does not restore the original registration.

## Binding behavior

- An existing valid ACTIVE Owner for the same binding uses ordinary Host resume, preserving its CE Session and fencing token.
- A verified normal shutdown records its intent. Starting that native Session again may create a new CE Session for the same Endpoint, Participant and Exchange through ordinary `requireUnowned` admission.
- Explicit messaging deactivation remains Detached until the existing Activate/Connect flow is used. Legacy release records without an intent also require explicit activation.
- The first repair of an old persisted lifecycle failure requires one unambiguous original mapping, all matching failure records, the current live-session v2 registration, complete persistent history and no previous recovery journal. It preserves the original identity and history while creating a fresh CE Session.

Current policy, process mutex and Host checks always apply. A journal carries diagnostic evidence, never authority. Shared transport is managed separately; restoring the Pi binding does not start transport.

## When offline maintenance is necessary

Automatic restoration does not take over an Owner or reconcile an abandoned mutex. An active or expired Owner, an unreconciled mutex, a process failure latch, invalid history or an uncertain attempt prevents restoration. Repeated reloads do not clear process failures.

Before maintenance, record the native Session ID/file, Endpoint, Participant, Exchange, old CE Session, Owner fence and complete lease term. Back up the session file, configuration/policy and a consistent SQLite snapshot. Keep credentials, capabilities and message bodies out of logs.

Coordinate all processes able to open this Store or acquire its mutex scope, including other Pi sessions, MCP children, heartbeats, background launchers and automatic restart jobs. Stopping shared transport affects other sessions. Sending a coordination message does not establish peer receipt or agreement.

1. Stop the relevant processes and inhibit restart. Independently establish that the original mutex Owner PID is dead. A live PID refuses even when its CE lease has expired.
2. Follow the [existing mutex procedure](tunnel-setup.md#故障排查先定位层再进行最小修复) with `scripts/reconcile-session-process-mutex.mjs`. Verify the exact scope, slot, PID/birth, owner-byte SHA256 and Store/slot/owner device/inode identities. Do not delete markers or write release receipts manually.
3. Follow the [stale-Owner procedure](chatgpt-installation.md#显式-stale-ownership-恢复) with `scripts/recover-stale-ownership.mjs`. Its operator configuration must select the original Pi adapter and Endpoint; a `chatgpt/main` binding targets a different Participant. Supply the freshly inspected complete Owner tuple. Retain the receipt and verify UNOWNED, increased fencing high-water and a DETACHED temporary recovery Session.
4. Stop on refusal, changed evidence or an unknown result. These tools check separate boundaries and do not share a transaction. Do not repeat a command to discover an unknown outcome.

After the authorized cleanup, load the verified extension and resume the same native Session. Eligible restoration runs during startup. Keep the original registration, session file, messages, failure records, policy chain and mutex history.

## Persistence and interruptions

Restoration first checks that the original Participant, Exchange and membership still exist and match current policy. Known Owner or mutex refusals occur before a recovery attempt is recorded. After ordinary mutex admission, a repair attempt is persisted and verified before Host authority writes; the new ACTIVE mapping and exact resolution must be persisted before Attached is published.

The extension checks the complete JSON-persisted history against the real native Session file through one held regular-file descriptor. Missing persistence, malformed or partial lines, unexpected appends, truncation and file replacement refuse. File synchronization does not guarantee hardware or power-loss durability.

An incomplete attempt blocks automatic retries and explicit Activate/Connect for that native Session. An invalid journal or foreign Endpoint failure also blocks both paths and requires separate operator investigation; activation cannot bypass the refusal. A complete matching commit only supports subsequent ordinary revalidation. A later failure or current process/global failure latch still denies; UNOWNED alone does not resolve uncertain writes. No failure marker or session history is deleted. Conversation rollback cannot hide a committed binding or an unresolved attempt.

## Acceptance

Verify the original native Session, Endpoint, Participant and Exchange and real `Current Session Attached`. For a repaired binding, also verify a new CE Session and increased fencing. Check heartbeat and mapping continuity through reload, normal quit/restart and intentional deactivation.

Within existing authorization, verify actual send, inbox, payload read and ACK, then the required Hook behavior. ACK records reception only. Connected transport, Attached UI and isolated tests do not replace original-session message and Hook acceptance.
