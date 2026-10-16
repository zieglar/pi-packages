# Private delivery ACK storage contract (E2-A)

Implementation candidate for HANDOFF-CE-P3B-02. Parent review/acceptance remains required. No Pi/MCP/host transport surface is added or enabled.

## Meaning and authority

An ACK is an immutable recipient reception statement: one receipt plus one `receipt_recorded` audit. It is not proof of reading, understanding, processing, exactly-once delivery/execution, task recovery, or task completion. Wayforge retains governed task authority; Pi retains runtime/transport authority. `DELIVERY_UNKNOWN` does not become `CANCELLED`.

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

See `storage-contract.md` for current-only v7 bootstrap/gates. Existing historical migration code remains immutable and is not an E2-A upgrade or normal-open path. Volume traversal tests establish bounded work/index use, not a production latency SLO or release authorization.
