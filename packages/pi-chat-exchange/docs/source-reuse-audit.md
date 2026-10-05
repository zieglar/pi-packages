# Source Reuse Audit — frozen conclusions (PH-0002, 2026-10-06)

This file freezes the managed audit conclusions used by the PH-0002
architecture correction. Full read-only audit reports (pins, integrity
hashes, line-level evidence) live with the parent session artifacts; nothing
was copied from these sources into this package, and no new dependency was
added. All sources are MIT licensed — no license blocker anywhere.

## Reproducible source pins

- `pi-intercom@0.16.1`: [npm source tarball](https://registry.npmjs.org/pi-intercom/-/pi-intercom-0.16.1.tgz),
  SHA-256 `9e109e9bde5b0caada2f79f157a1d864501b62c576e44d28150396078c6241c6`.
  Full `LICENSE`: MIT, copyright 2026 Nico Bailon. npm metadata has no
  repository URL; the tarball, not an assumed GitHub repository, is the source pin.
- `remote-pi`: [upstream](https://github.com/jacobaraujo7/remote_pi),
  audited commit `79bbea2b9f6aee7e21dce344a0d4e3a7add50467`. Root and extension
  LICENSE are MIT, copyright 2026 Jacob Moura. npm 0.7.0 is an older artifact
  (release commit `c6e3a3b607ffbc18fe447550865af37a1253b060`), SHA-256
  `6212263034bbef33f1703a64a5a14f8470f2031a88d958c00e62234a6ec420a3`.
  Source line references below are to the audited commit, not npm dist.
- `@nicknisi/pi-relay@0.4.0`: [upstream source](https://github.com/nicknisi/pi-extensions/tree/main/packages/relay),
  [pinned tarball](https://registry.npmjs.org/@nicknisi/pi-relay/-/pi-relay-0.4.0.tgz),
  SHA-256 `30e59ffa7b85d06df613ddadbe86e2dda403a2133c29dcfdb36dca06cd26d261`, MIT.
- Official Pi: distribution `@earendil-works/pi-coding-agent@0.86.1`,
  `examples/extensions/handoff.ts:92,177–196`; documented APIs in `docs/extensions.md`.
  The installed 0.85.1 copy was additionally inspected, not confused with 0.86.1.

## Focused implementation evidence

### pi-intercom

- Discovery: broker registration/roster and presence broadcasts; exact ID,
  prefix or unique alias addressing, ambiguous names rejected
  (`types.ts:145,174–176`, `broker/broker.ts:806`, `index.ts:1588`).
- Identity: stable extension claim/config/env fallback then session ID
  (`index.ts:556`); fresh endpoint epoch on registration and epoch-pinned sends
  (`broker/broker.ts:470,651–674`). Runtime-only fallback aliases are not resume identity.
- Injection: public `sendMessage` and idle `sendUserMessage`
  (`index.ts:1289–1304`); no terminal/PTY injection. Receiver
  `received/acknowledged/injected` receipts distinguish socket/queue acceptance
  from injection, but do not prove execution or settlement (`types.ts:100–106`).
- Correlation: message ID, replyTo/ask edges/retryOf/supersedes
  (`types.ts:84–113`, `reply-tracker.ts:44–70`). Sender fingerprint dedupe is
  broker-memory, bounded to 4096 entries/one hour (`broker/broker.ts:46–47,1076–1110`);
  receiver seen IDs are memory-only (`index.ts:699–721,1368–1370`).
  Queued mail is memory-only; pending asks and sent session entries are persisted
  (`broker/broker.ts:1213–1240`, `index.ts:1805,2280–2286`), not a durable inbox.
- Herdr: live snapshot-based location (`herdr-location.ts:36–58`); remote SSH relay
  with `ssh-asserted` trust (`cross-machine-transport.ts:78–113`). Optional capability,
  not a protocol dependency.
- Composition: documented extension event API has discovery/pubsub/owner/CAS
  and outbox (`extension-api.ts:19–98`). Outbox requests correlate by ID but
  timeout/session-end errors generalize failure (`index.ts:1195–1257`).
  The target injects before our extension can apply its own durable receiver
  fencing/dedupe. No published standalone broker-client library exports;
  default extension is monolithic. Discovery-only composition remains viable.

### remote-pi

- UDS/named-pipe broker, register/list peers and cwd@name aliases
  (`pi-extension/src/session/{ipc.ts:39–49,broker.ts:333–397,604–624}`).
  UUIDv7 envelope IDs plus reply correlation (`envelope.ts:7–13,65–88`).
- ACK `received` follows `socket.write` (`broker.ts:539–553,588–602`), not
  receiver acceptance or execution. Receiver pending mesh buffer is in-memory
  and drained with public `sendMessage` (`src/index.ts:4132–4179`).
- No message idempotency/dedupe or durable inbox. Audit append is best-effort,
  not replayed for recovery (`broker.ts:646–673`). Sending tool permits the
  LLM to decide on timeout retry (`tools.ts:31–46`); no unknown quarantine.
- Useful references: envelope framing, cross-platform IPC, join-or-lead and
  router boundary. No stable exported transport library; deep imports would
  bind to changing internals. Daemon/RPC/mobile/hosted-relay features are not
  required for this project and will not be installed.

### Official handoff and pi-relay

- Official handoff is TUI context summarization, newSession and editor draft,
  not a mailbox, transport, existing-session discovery or delivery ACK.
- Relay's public `./core` export is materially different from the monoliths
  (`package.json`, `core.ts:221–228`). Mailbox claims/exact-ID ACK/uncertain
  receipts are useful references (`mailbox.ts:1–23`). But
  `index.ts:268–299` catches injection errors and tries steer/followUp/fallback;
  claim recovery does not itself prove the first attempt had no effect.
  Do not adopt that path as guaranteed no-retry after ambiguity.

## Verdicts

| Source | Version audited | Verdict |
| --- | --- | --- |
| `pi-intercom` | 0.16.1 (npm tarball, pinned integrity) | REFERENCE_ONLY |
| Official Pi handoff example (`examples/extensions/handoff.ts`) | read at the actual user runtime 0.86.1 (documented mise install path); child audit also covered installed 0.85.1 — versions deliberately labeled | REFERENCE_ONLY (new-session/editor-draft pattern; existing-session injection API evidence comes from official `extensions.md`) |
| `@nicknisi/pi-relay` | 0.4.0 | REFERENCE_ONLY (strongest design reference) |
| `remote-pi` | npm 0.7.0 / repo pinned by SHA (fast-moving; HEAD ≠ npm artifact) | REFERENCE_ONLY |

## Why composition was not claimed

The decisive ground is the same for the comm plugins: none of them offers a
seam where OUR durable dedupe, lease fencing, and explicit no-retry decision
can execute BEFORE their own injection/retry machinery acts. Secondary
facts (in-memory state, differing ID formats, socket-level ACK semantics)
are recorded below as facts, not as the refusal grounds — none of them alone
disqualifies composition.

- **pi-intercom 0.16.1** exposes an in-process extension bus with discovery
  (`listSessions`), generic pub/sub with owner election, epoch-fenced CAS
  commits, and an outbox. The outbox itself AUTO-INJECTS
  `sendMessage`/`sendUserMessage` from its own in-memory dedupe, with no hook
  where our durable dispatch-start attempt record and lease fencing could
  gate the injection first; outbox timeouts and session-end conditions
  surface as generalized, opaque failures rather than correlated
  delivered/ambiguous/failed evidence. Facts, not the refusal ground: its
  broker idempotency and duplicate suppression are in-memory (lost on
  restart) and its identity format differs from ours. Discovery-only
  composition (against an already-installed intercom) remains a possible
  later addition; nothing here depends on it.
- **Official handoff example** (`examples/extensions/handoff.ts`, read at the
  actual user runtime 0.86.1 at the documented mise install path; a child
  audit also covered the installed 0.85.1 — versions deliberately labeled):
  the example itself is a NEW-session flow — summarize the current session,
  edit the draft, `newSession` with parent tracking. It is NOT evidence of
  existing-session injection. The public injection API evidence
  (`pi.sendMessage` custom messages with `deliverAs`/`triggerTurn`,
  `pi.sendUserMessage`, session identity, `appendEntry`) comes from the
  official `extensions.md` documentation verified at 0.86.1. The example is
  cited for the new-session pattern and editor-draft flow only.
- **pi-relay 0.4.0** has a published durable Pi-free core (claim/ACK/requeue/
  recover, exact-id dedupe, `uncertain`-never-delivered receipts) — the
  closest prior art to our quarantine design. But its delivery ladder
  (steer → follow-up → fallback) retries inside catch-all exception handlers
  and claim recovery, and those paths may have side effects it cannot
  account for; we therefore cannot claim that composing it preserves our
  fail-closed no-retry quarantine — it is not fail-closed in our sense, and
  no claim of complete no-effect certainty is made about it.
- **remote-pi** (npm 0.7.0 / repo pinned by SHA): its broker ACK (`received`)
  after a socket write is transport acceptance, not runtime acceptance — a
  semantics fact, not by itself a refusal ground. The refusal ground is that
  its injection path (in-memory pending mesh buffer, drained via
  `sendMessage`) offers no seam for our durable dedupe/fencing/no-retry to
  run first, and its retry decision is delegated to the sending LLM. Facts,
  not the refusal ground: no idempotency or duplicate protection on its
  message path; differing ID/addressing formats. Its clean transport seams
  (envelope framing, UDS join-or-lead, router injection boundary) are design
  references only.

## Patterns adopted (as patterns, not code)

Receipt ladders separating accepted/executed; content-fingerprint
idempotency; fencing-token keys; explicit `ambiguous` outcomes with
investigate-before-resend; audit lines with digests/lengths instead of raw
bodies. Patterns avoided: in-memory-only delivery state, opaque timeout
errors, LLM-owned retry.

## Caveats (frozen)

- Availability of public Pi APIs is necessary but NOT correlated durable
  acceptance or settlement proof. Only attempt-correlated evidence recorded
  through the core rules may move a Message's lifecycle.
- Real client-product acceptance (ChatGPT or otherwise) remains **NOT_RUN**
  (see [phase-0-evidence.md](phase-0-evidence.md), archival).
- PH-0001's ChatGPT support/tunnel/Work-chat findings, public owning-session
  API findings, RPC rejection, and "Moshi/Herdr not required" conclusion are
  preserved unchanged in the archival evidence doc; none were re-researched.
