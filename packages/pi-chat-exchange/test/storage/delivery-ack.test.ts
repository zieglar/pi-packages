import { afterEach, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ReceiptSchema } from "../../src/protocol/entities.js";
import { recordDeliveryAck, reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { openStore } from "../../src/storage/store.js";
import { cleanupFixtures, capabilityFor, reader } from "./support/participant-fixture.js";
import { ackWorld, changes, snapshot, clockAt, S1 } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
it("ACK-REC-01/first-ack-and-reopen + ACK-AUTH-01/valid-session-bound: real pair and frozen projection",()=>{
  const w=ackWorld();
  const before=snapshot(w.f,["delivery_ack_receipt","audit_event"]);
  const result=recordDeliveryAck(w.f.store,w.input,clockAt(10));
  const db=reader(w.f);
  const rows=db.prepare("SELECT * FROM delivery_ack_receipt").all();
  expect(rows).toHaveLength(1);
  const r=rows[0]!;
  expect(r).toMatchObject({exchange_id:w.exchangeId,message_id:w.input.messageId,recipient_participant_id:w.recipient,
    ack_session_id:S1,ack_fencing_token:1,trust_generation:1,payload_digest:w.input.payloadDigest,payload_length:4,
    message_created_audit_seq:w.input.messageCreatedAuditSequence,private_revision:1,created_at:clockAt(10).now()});
  const audits=db.prepare("SELECT * FROM audit_event WHERE kind='receipt_recorded'").all();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({exchange_id:w.exchangeId,subject_id:r.receipt_id,digest:w.input.payloadDigest,length:4,outcome:"delivery_ack",created_at:r.created_at,private_revision:1});
  expect(audits[0]!.sequence).not.toBe(w.input.messageCreatedAuditSequence);
  expect(result).toMatchObject({disposition:"CREATED",receiptAuditSequence:audits[0]!.sequence,receipt:{receiptId:r.receipt_id,kind:"delivery_ack",endpoint:w.endpoint}});
  expect(Value.Check(ReceiptSchema,(result as {receipt:unknown}).receipt)).toBe(true);
  expect(snapshot(w.f,["delivery_ack_receipt","audit_event"])).toBe(before);
  db.close();w.f.store.close();
  const reopened=openStore({directory:w.f.directory,filename:w.f.filename});
  expect(reconcileDeliveryAck(reopened,w.input,clockAt(11))).toMatchObject({disposition:"COMMITTED",receipt:(result as {receipt:unknown}).receipt});
  reopened.close();
});
it("ACK-REC-02/sequential-equivalent + AUTHORITY-01/committed-original-id: zero-write replay and diagnosis",()=>{
  const w=ackWorld();const first=recordDeliveryAck(w.f.store,w.input,clockAt(10));
  const before=snapshot(w.f);const n=changes(w.f);
  expect(recordDeliveryAck(w.f.store,w.input,clockAt(11))).toEqual({...first,disposition:"REPLAYED"});
  expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(11))).toEqual({...first,disposition:"COMMITTED"});
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
it("AUTHORITY-01/no-trace-no-approval: absence is read-only, never an automatic ACK",()=>{
  const w=ackWorld();const before=snapshot(w.f);const n=changes(w.f);
  expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(10))).toEqual({disposition:"NO_TRACE"});
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
it.each(["digest","length","creation-seq"])("ACK-REC-02/conflict-%s: metadata refuses without overwrite",field=>{
  const w=ackWorld();recordDeliveryAck(w.f.store,w.input,clockAt(10));
  const before=snapshot(w.f),n=changes(w.f);
  const bad={...w.input,...(field==="digest"?{payloadDigest:"a".repeat(64)}:field==="length"?{payloadLength:3}:{messageCreatedAuditSequence:1})};
  for(const operation of [recordDeliveryAck,reconcileDeliveryAck]) expect(()=>operation(w.f.store,bad,clockAt(11))).toThrow();
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
it("AUTHORITY-01/wrong-reconcile-scope: exact ACK credential required before lookup",()=>{
  const w=ackWorld();
  const capability=capabilityFor(w.f,w.recipient,"read",{sessionId:S1});
  const before=snapshot(w.f),n=changes(w.f);
  expect(()=>reconcileDeliveryAck(w.f.store,{...w.input,capability},clockAt(10))).toThrowError(expect.objectContaining({code:"CAPABILITY_REJECTED"}));
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
