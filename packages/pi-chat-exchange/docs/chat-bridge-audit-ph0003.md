# PH-0003 — Chat bridge source audit and endpoint comparison

Read-only audit; downloaded sources were not installed or executed. No external
code was extracted into this project or introduced as a dependency. Findings
describe pinned implementations, not actual
Desktop integration acceptance (NOT_RUN). Owner approved model C before contract
changes: **ControlSurface + capability-oriented Endpoint integration**.

## Reproducible pins and license evidence

Full LICENSE files were read, not inferred from READMEs.

| Repository | Audited commit | License | Source archive SHA-256 |
| --- | --- | --- | --- |
| [kajmahal/chatgpt-conversations-mcp](https://github.com/kajmahal/chatgpt-conversations-mcp) | `4c2640d88cc95df1fa3d4d1c60f433d452c97351` | Apache-2.0 | `6b03fe4ff77c4ce41f88dd30fa70d2e682a70bde82d9d700561d8188d958b810` |
| [hxmzadmr/probridge](https://github.com/hxmzadmr/probridge) | `e9ed93fb92f39a04eb106488be7733b396eecff0` | MIT, Hamza Demir | `d778ac74ca09585b521b55c2dbfcc3aed41d92f14fe06384c398c6ebedaea570` |
| [connectedGraph/chatgpt-desktop-bridge](https://github.com/connectedGraph/chatgpt-desktop-bridge) | `4d159df296ac3443972782611505806407ebefd5` | MIT, Springingly | `67ce45dae99edd0e5be319e447d792b2ac2e25256e885703afbb46f868626ca9` |
| [ysbiyiklioglu/ChatGPT-Bridge](https://github.com/ysbiyiklioglu/ChatGPT-Bridge) | `3c9e5d6a8000f86b218d8eb1b585a2e9f22acaf1` | MIT | `1f743d0dcc41952ea81b86162fefc4ad784b96387d97b318663a820e07e09932` |

Retrieve the repository archive at its exact commit; source handles below refer
to that tree. Temporary checkout paths under `/tmp/ph0003-source-audit` are not
required to reconstruct the audit. Every bridge verdict is **REFERENCE_ONLY**;
its private/UI transport is rejected as our implementation dependency.

## A. chatgpt-conversations-mcp

Sources: `src/{mcp-server,message-service,bridge,native-call,pipe-client,
desktop-locator,refreshing-bridge}.mjs`.

1. Existing conversation identity: native `thread.id`, exposed as `conversation_id`.
2. Lists threads via `list_threads`, filtered to `kind=chatgpt`, pinned/recent.
3. Reads existing thread via paginated `read_thread(threadId,cursor)`; repeated
   cursors are rejected.
4. Sends into an existing target via `send_message_to_thread(threadId,prompt)`;
   writes enabled separately and a pre-read refuses an active thread.
5. Native JSON-RPC UUID/callId correlates RPC. Response selection finds a NEW
   turn absent from baseline IDs, with exact matching sent user text; assistant
   text belongs to that turn. This is heuristic, not durable message dedupe.
6. Conversation ID exists independently of request, target turn and carrier IDs.
7. MCP stdio -> service -> Windows `codex-browser-use-*` named pipe, four-byte
   little-endian length-prefixed JSON.
8. Native `tools/call`, namespace `codex_app`, carrier threadId/turnId/callId
   relies on private/internal Desktop machinery, NOT the supported custom-plugin
   path established in PH-0001.
9. Useful: independent address/read/write seams, endpoint versus turn/RPC identity,
   send once then observe, no write retry after ambiguity. Unsafe dependencies:
   private pipes/tools, carrier creation, no receiver fencing/durable dedupe.
10. Apache-2.0; no code reuse proposed.

Only an in-memory per-conversation lock; no persisted dispatch/result/inbox.
Read rediscovery retries once; write failure invalidates cache but NEVER resends.
Default native timeout 12 seconds and reply polling 90 seconds.
`completed` is inferred from assistant text, not authoritative turn settlement.
`sent_reply_pending` versus `delivery_uncertain` is a useful distinction, not
execution proof. The source demonstrates an addressable-conversation *concept*,
not an officially supported production integration.

## B. ProBridge

Sources: `src/server.mjs` (startJob/statusJob/followupJob), `src/daemon.mjs`
(handle/recoverOnStartup/watchJob), `src/lib/{queue,dispatch,ui-worker,ax-driver,
fs-atomic,control-sync,job-file}.mjs`, `src/native/ax-driver.swift`.

1. `jobId` represents ONE processing round; not a native conversation identity.
   Initial `threadId` equals first jobId; follow-ups preserve that logical aggregate.
2. `start` enqueues through a daemon and immediately returns jobId/status/position
   after admission, not model completion. `status` is a separate MCP call.
3. Follow-up requires latest completed round, no other active round and verified
   title; creates a fresh jobId/nonce, same threadId, next round and parentJobId.
4. MCP process continues serving calls, but the initial tools/call does not wait
   for the external model to finish.
5. State vocabulary includes queued/submitting/submitted/running/settling/complete/
   failed, dispatch_unknown/protocol_missing/timed_out/cancelled. Cooperative file
   reports correlate jobId/nonce/workspace/round/parent/thread; UI also informs
   settlement. Status reads can APPLY observations and mutate state: do not adopt
   that behavior as our non-mutating Result reads.
6. JSON queue + backup, mutex and atomic rename in a private runtime directory.
   Persistent across restart; source does not establish fsync durability or exactly
   once delivery. Nonces/markers are not endpoint authentication.
7. Startup resumes watchers/reconciles submitting. Persisted send-phase ambiguity
   becomes dispatch_unknown without resend; recovery before sending may fail safely.
8. MCP stdio -> local Unix socket -> detached daemon -> Swift Accessibility/CGEvent
   Quick Chat UI driver targeting `com.openai.codex`; captured title and markers,
   not CDP or an official conversation-addressing API.
9. Reusable ideas: aggregate/thread vs per-round job vs dispatch identity,
   submit/admit/poll, intent before effects, restart quarantine. UI titles, mutable
   cooperative reports and product effort/model fields are unsuitable generic proof.
10. MIT. No daemon execution/installation/extraction proposed.

Its persisted opaque job identity is a processing/correlation handle, NOT proof of
native conversation addressability. One logical aggregate with successive rounds
maps conceptually to Exchange + independent Messages/Attempts, not one immortal job.

## C. ChatGPT Desktop Bridge

Source: `bridge.py`, especially `CDPBridgeClient.call`,
`get_dom_conversation_id`, `send_chat_message`, and the HTTP handler.

1. Addresses ONLY the current DOM conversation. A supplied different ID creates
   a NEW chat, rather than selecting that existing conversation.
2. ID derives from DOM `data-response-annotation-conversation` or prefixes of
   `data-content-search-{unit,turn}-key`; `current_conv_id` is memory-only.
   Backend-looking IDs do not establish stable resume semantics in this bridge.
3. Omitted/new ID creates chat; matching current ID continues; mismatch creates
   another chat. No list/read-by-arbitrary-ID support found.
4. HTTP requests serialize under an asyncio lock. CDP numeric IDs correlate RPC;
   assistant count/latest DOM text locates response. Stop-button disappearance
   and text stability guess completion; HTTP completion UUID is not dispatch identity.
5. CDP call reconnects/retries ANY method twice, including effects. A 75-second
   poll timeout may return partial/last text; HTTP 80-second timeout returns 500
   without cancelling the future. None proves no effect or runtime settlement.
6. Debug-port discovery + CDP WebSocket `Runtime.evaluate`/Input events +
   ProseMirror/DOM selectors; launches Desktop with remote debugging enabled.
7. Transport rejected: private selectors and duplicate-effect retries.
8. Useful distinction: conversation identity versus RPC/completion identity;
   HTTP control versus CDP integration. Never advertise arbitrary addressability
   merely because an API accepts a conversation_id parameter.
9. MIT. No durable queue/dedupe/evidence/recovery registry.

## D. ChatGPT-Bridge

Inspected BOTH `server/src/{mcp-server,ws-server,index}.ts` and `server.cjs`, plus
extension background/content sources. Catalogs differ: TS hyphenated send/status/
new-chat/history/debug; CJS underscore variants add quick/upload/images/download.

MCP stdio -> local WebSocket (optional HTTP frontend) -> MV3 extension background
-> content-script DOM manipulation/scraping. Optional native messaging helper is
not stable conversation addressing. First matching ChatGPT tab is selected: no
conversation-ID routing/listing. History is current visible DOM, with in-memory
server history; `_maxHistory=20` is declared but not enforced by inspected code.

Server UUID requestId maps WS result/error to pending requests. Content script
POLL_RESULT uses ONE global pending/result/error slot without requestId, so concurrent
requests can mix observations. `started` ACK precedes actual-send/acceptance proof.
Timeout/disconnect reject pending promises; reconnect restores socket, not durable
execution correlation. chrome.storage persists connection metadata, not inbox/results.
Stop/text-stability timeout may return last text, not settlement.

File upload is base64/Blob/paste; ACK can mean paste attempted, not processing
completion. This does not justify a generic file protocol in PH-0003. MIT.
Lessons: control/integration separation, independent tab/conversation/request/
execution IDs, correlation at EVERY boundary, acknowledgement strength must be explicit.

## Material supplemental evidence; not an ecosystem catalogue

Public GitHub searches covered existing Claude conversation MCP, Codex session MCP,
asynchronous job/task bridges, desktop conversation bridges and Pi MCP; npm metadata
was also triaged. Search metadata was not treated as source proof. A web-search
provider had a partial failure; direct GitHub/npm HTTPS searches succeeded. Only
two official references materially sharpened the decision; no new dependency.

- [openai/codex](https://github.com/openai/codex), commit
  `7aa8f510496316b86a91a75ed0a71598ef03c640`, Apache-2.0 full LICENSE read.
  Actual generated protocol under `codex-rs/app-server-protocol/schema/typescript/v2/`:
  ThreadResumeParams rejoins running thread by ID or loads from disk;
  ThreadListParams enumerates threads; TurnStartParams targets threadId;
  TurnCompletedNotification binds threadId + Turn; TurnInterruptParams binds
  threadId + turnId; TurnStatus separates inProgress/completed/failed/interrupted.
  REFERENCE_ONLY: materially corroborates endpoint identity versus per-turn
  correlation and conditional observation/cancellation, not runtime integration.
- [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol),
  commit `8e12bf3c8f01f374146acfa19b8ece0018bfc86c`, actual
  `schema/2025-11-25/schema.ts:1302–1500` and ToolExecution.taskSupport.
  Task creation/status/result/cancel/list carry taskId/status/ttl/pollInterval;
  notifications are optional and task support forbidden/optional/required.
  RPC task identity is NOT conversation identity or external execution proof.
  Bidirectional sampling/elicitation likewise is not named-conversation injection.
  Root LICENSE records Apache-2.0/MIT transition and CC-BY-4.0 for non-spec docs;
  no extraction/reuse proposed. REFERENCE_ONLY.

## Cross-endpoint capability comparison

ChatGPT column is the strongest audited native-pipe example, NOT a supported API
or our implemented adapter. Others are weaker (AX title, current DOM, first tab).
Pi column uses PH-0002 evidence unchanged: `source-reuse-audit.md`.

| Capability | ChatGPT-style endpoint evidence | Pi endpoint evidence |
| --- | --- | --- |
| stable address | native thread ID; private, no supported stability promise | durable session binding feasible; install/session mapping stays local |
| receive message | native send to existing thread | public owning-session sendUserMessage/sendMessage |
| produce result | text/turn heuristic; not settlement proof | output observable; correlated publication still required |
| follow-up | same thread, independent turn/request | same session, independent incoming Message |
| correlation | RPC + turn IDs, exact-text heuristic | Message/Attempt plus runtime observation must be integrated |
| runtime instance | not normalized/persisted | fresh process/registration epoch feasible |
| delivery ACK | private RPC response, ambiguity tracked | receipt tiers/API return; not inherently execution proof |
| execution observation | weak text/status heuristics in bridges | lifecycle events available; per-message correlation not automatic |
| cancellation | unsupported/unproven in these bridges | cancellation confirmation not established by audited seam |
| durable receiver dedupe | absent | absent from public API; must be built before effects |

These are capability/evidence differences, not intrinsic client/agent roles.
Existing Pi plugins remain REFERENCE_ONLY: intercom roster/epochs/receipt ladder,
remote-pi socket transport/registration, relay mailbox core and official handoff
context summary are useful concepts; their existing injection/retry machinery is
not adopted. Optional discovery composition remains separate from our minimal
owning-session endpoint integration decision.

## Architecture conclusion

MCP is a **control/API surface**, not automatically the invoking conversation's
endpoint integration. A caller principal and an addressable target are separate
identities. Conversations and runtimes can be protocol peers when integrations
supply real capabilities, with no forced parity. Grant scopes bind authenticated
principal + action + Exchange/Message/Attempt/recipient incarnation/owner as relevant.
Missing support stays unknown/unsupported; no evidence is synthesized. Reads are
non-mutating; Result is processing evidence, reply is a separately routed Message.
The authorized unresolved disposition remains administrative, not execution proof.
