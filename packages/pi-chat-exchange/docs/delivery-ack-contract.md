[English](delivery-ack-contract.md) | [简体中文](delivery-ack-contract.zh-CN.md)

# Private delivery ACK storage contract (E2-A)

The storage contract was implemented in stage E2-A. The later operator surface adds the opt-in MCP/host interface described below without changing that storage contract. This document is not evidence of real ChatGPT dogfood or release.

## Meaning and authority

An ACK is an immutable recipient reception statement: one receipt plus one `receipt_recorded` audit. It is not proof of reading, understanding, processing, exactly-once delivery/execution, task recovery, or task completion. The external workflow or operator retains governed task authority; Pi retains runtime/transport authority. `DELIVERY_UNKNOWN` does not become `CANCELLED`.

Private `recordDeliveryAck(store, input, seams?)` accepts exactly the host fields `participantId`, `sessionId`, `fencingToken`, `capability`, `exchangeId`, and copied Message metadata `messageId`, `payloadDigest`, `payloadLength`, `messageCreatedAuditSequence`. Inputs are captured once; unknown fields and invalid scalar types are refused without echoing values. These host authority fields are not a proposed public caller input.

Order within the existing owned transaction:

1. `BEGIN IMMEDIATE` acquires the SQLite writer lock.
2. Trusted post-lock time tA is sampled once.
3. Exact independent Session-bound `ack` capability and current Owner/Session/fence/lease authorize. Revocation, detached/unbound Session, wrong scope, expiry equality, and clock regression fail closed before Message/receipt/audit lookup.
4. Membership, stable recipient binding, immutable join boundary, exact creation audit, raw body SHA-256 and byte length are checked.
5. Natural key `(exchangeId, messageId, recipientParticipantId)` evidence is checked.
6. Equivalent evidence replays with zero writes. A first ACK requires OPEN Exchange without administrative disposition, and inserts the receipt/audit pair atomically.
7. Confirmed COMMIT precedes publication.

An operation valid at tA may commit after lease expiry; there is no commit-time reauthorization or renewal. The next expired call refuses even if a receipt exists.

## Evidence and projection

`CREATED` or `REPLAYED` returns `{disposition, receipt, receiptAuditSequence}`. The frozen public Receipt contains only `receiptId`, `exchangeId`, `messageId`, stable recipient `endpoint`, `kind: 'delivery_ack'`, `createdAt`. The actual protocol receipt prefix is **`rcpt_`**, not `rcp_`.

Private rows retain original acknowledging Session/fence/trust-generation, digest/length, exact Message creation sequence, time and revision=1. The audit subject is the receipt ID, outcome `delivery_ack`, with matching original digest/length/time. Receipt audit sequence is distinct from Message creation sequence. A new authorized Owner can replay original evidence; provenance is never rewritten. CLOSED existing receipt replay/query is allowed with current authorization/eligibility; CLOSED first ACK is refused.

Partial, duplicate or inconsistent evidence refuses; there is no repair, IGNORE or REPLACE. An orphan receipt audit cannot identify a Message by itself: an absent natural key conservatively refuses any orphan receipt audit in that Exchange. That additional integrity scan uses the existing correlation index but is not claimed constant-cost as receipt volume grows. No additional index is introduced.

## Uncertain outcome and read-only reconciliation

Private `reconcileDeliveryAck` has identical closed input, current authorization and eligibility. It returns original `{disposition:'COMMITTED', receipt, receiptAuditSequence}` or `{disposition:'NO_TRACE'}` with zero durable changes. It does not issue credentials, renew leases, restore ownership, retry ACK, send, cancel, or declare completion.

`NO_TRACE` is absence in that serialized snapshot only. A live original paused before BEGIN can later commit. Even proven original quiescence does not grant retry approval. There is no upper-layer retry orchestration in this implementation.

Proven rollback and `INDETERMINATE` remain distinct. Busy does not authorize retry. Uncertain COMMIT/rollback invalidates the old connection and withholds success. Fresh exact-authorized diagnosis after original quiescence examines durable evidence; it never manufactures missing evidence. A lost caller response can coexist with a complete committed pair.

## Isolation, pagination and privacy

ACK never changes Message/state/body/revision, attempt, claim, cursor, result, ownership, membership, task or transport state. Reads/discovery never implicitly ACK; ACK does not hide Messages. Receipt audits occupy raw inbox scan budget. Continuation remains the last raw sequence actually examined, not an ACK watermark or prefetch tail. Empty receipt-only pages can advance continuation without returning Messages; callers explicitly request subsequent pages.

No bodies, credentials, host secrets or arbitrary causes enter receipt/audit results, logs or errors. Private hooks are synchronous, value-free, capture defensively, reject unsupported results without inspecting them, and replace caller exceptions before domain-error translation. Test instrumentation is privileged, not a sandbox.

## MCP surface (the operator surface stage)

One opt-in MCP tool now exposes this committed storage contract. The private
storage functions, their ordering, and their guarantees above are unchanged.

- The tool is named `ce_ack`. Its closed input is exactly `{messageId,
  payloadDigest, payloadLength, messageCreatedAuditSequence}`; unknown fields
  and any authority-bearing field are rejected as JSON-RPC invalid params
  before any port call. The digest, length, and creation sequence must be
  copied from an authorized read (`ce_read_payload` returns exactly
  `payloadDigest`, `payloadLength`, and the creation `auditSequence`) — never
  computed or transformed by the caller or model.
- The host injects Participant, Session, fencing token, the Session-bound `ack`
  capability, and the Exchange. The caller supplies no authority field, and the
  capability is issued only while the operator opt-in is enabled (at
  provisioning and at a validated `resume`); it is memory-only.
- Advertisement is operator opt-in only: the MCP binding configuration gains an
  optional `"ack": { "enabled": boolean }` section, disabled by default. A
  deployment without the opt-in advertises exactly `ping`, `ce_send`,
  `ce_inbox_list`, `ce_read_payload`, and a `ce_ack` call there fails closed
  (MethodNotFound). With the opt-in, `ce_ack` is listed last.
- A disabled policy refuses `CE_HOST_ACK_DISABLED` before registration state.
  Storage refusals map through the existing sanitized host refusal set
  (`CE_HOST_AUTHORITY_ABSENT`, `CE_HOST_INVALID_REQUEST`, `CE_HOST_BUSY`,
  `CE_HOST_UNCERTAIN`, `CE_HOST_UNAVAILABLE`); `CE_HOST_UNCERTAIN` is never
  retryable and must not be retried by the caller.
  For ACK only, `CE_HOST_BUSY` preserves the original safe storage reason and
  proven rollback classification, but both host and MCP report `retryable: false`
  as caller policy: rollback does not authorize retry. Another ACK invocation
  requires explicit operator or upper-layer approval; no retry is orchestrated.
  Existing send/read refusal behavior is unchanged.
- The tool response is the frozen public Receipt projection plus `disposition`
  and `receiptAuditSequence`: `CREATED` for the first ACK, `REPLAYED` with the
  identical original receipt for an equivalent repeat. The acknowledging
  Session, fencing token, trust generation, and capability never appear in any
  result, refusal, or log.
- Recording an ACK still changes no Message delivery state, cursor, inbox
  visibility, or task state, and remains a recipient reception statement
  only — not proof of delivery, reading, understanding, processing, or task
  completion.

See `storage-contract.md` for current-only v7 bootstrap/gates. Existing historical migration code remains immutable and is not an E2-A upgrade or normal-open path. Volume traversal tests establish bounded work/index use, not a production latency SLO or release authorization.
