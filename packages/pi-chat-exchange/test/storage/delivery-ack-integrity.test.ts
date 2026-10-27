import { afterEach, expect, it } from "vitest";
import type { SQLInputValue } from "node:sqlite";
import { generateEntityId } from "../../src/protocol/identity.js";
import { recordDeliveryAck, reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { cleanupFixtures, expectRefusal, capabilityFor } from "./support/participant-fixture.js";
import { ackWorld, snapshot, changes,clockAt,SENDER } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
for(const verb of ["update","delete"]) it(`ACK-REC-01/immutable-${verb}: guards preserve exact evidence`,()=>{
 const w=ackWorld();recordDeliveryAck(w.f.store,w.input,clockAt(10));const before=snapshot(w.f);
 expect(()=>w.f.store.database.exec(verb==="update"?"UPDATE delivery_ack_receipt SET private_revision=1":"DELETE FROM delivery_ack_receipt")).toThrow(/immutable/);
 expect(snapshot(w.f)).toBe(before);
});
const columns=["receipt_id","exchange_id","message_id","recipient_participant_id","ack_session_id","ack_fencing_token","trust_generation","payload_digest","payload_length","message_created_audit_seq","created_at","private_revision"];
const insert="INSERT INTO delivery_ack_receipt(receipt_id,exchange_id,message_id,recipient_participant_id,ack_session_id,ack_fencing_token,trust_generation,payload_digest,payload_length,message_created_audit_seq,created_at,private_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";
it("ACK-REC-01/foreign-keys: distinct restrictive tuple violations with successful rollback-only control",()=>{
 const w=ackWorld(),db=w.f.store.database;recordDeliveryAck(w.f.store,w.input,clockAt(10));const row=db.prepare("SELECT * FROM delivery_ack_receipt").get()!;
 const before=snapshot(w.f);
 for(const patch of [{message_id:generateEntityId("msg_")},{recipient_participant_id:"prt_01ARZ3NDEKTSV4RRFFQ69G5FAZ"},{ack_session_id:SENDER},{message_created_audit_seq:9999}] as Record<string,SQLInputValue>[]) {
  db.exec("BEGIN; DROP TRIGGER delivery_ack_receipt_nodelete; DELETE FROM delivery_ack_receipt");
  try {expect(()=>db.prepare(insert).run(...columns.map(k=>({...row,...patch})[k] as SQLInputValue))).toThrow(/FOREIGN KEY/);}finally{db.exec("ROLLBACK");}
 }
 db.exec("BEGIN; DROP TRIGGER delivery_ack_receipt_nodelete; DELETE FROM delivery_ack_receipt");
 try{expect(db.prepare(insert).run(...columns.map(k=>row[k] as SQLInputValue)).changes).toBe(1);}finally{db.exec("ROLLBACK");}
 expect(snapshot(w.f)).toBe(before);
});
it("ACK-REC-01/strict-checks: all safe-integer, digest, canonical-time and immutable revision gates",()=>{
 const w=ackWorld(),db=w.f.store.database;recordDeliveryAck(w.f.store,w.input,clockAt(10));const row=db.prepare("SELECT * FROM delivery_ack_receipt").get()!;const before=snapshot(w.f);
 const bad:Record<string,SQLInputValue>[]=[];
 for(const field of ["ack_fencing_token","trust_generation","payload_length","message_created_audit_seq"])
  for(const value of [-1,1.5,9007199254740992n,"invalid"])bad.push({[field]:value});
 for(const field of ["ack_fencing_token","trust_generation","message_created_audit_seq"])bad.push({[field]:0});
 for(const value of ["A".repeat(64),"g".repeat(64),"0".repeat(63),"0".repeat(65)])bad.push({payload_digest:value});
 for(const value of ["2026-10-10","2026-10-10T24:00:00.000Z","2026-02-30T00:00:00.000Z","2026-10-10T00:00:00Z"])bad.push({created_at:value});
 for(const value of [0,2,1.5])bad.push({private_revision:value});
 for(const patch of bad){db.exec("BEGIN; DROP TRIGGER delivery_ack_receipt_nodelete; DELETE FROM delivery_ack_receipt");try{
  expect(()=>db.prepare(insert).run(...columns.map(k=>({...row,...patch})[k] as SQLInputValue))).toThrow();
 }finally{db.exec("ROLLBACK");}}
 expect(snapshot(w.f)).toBe(before);
});
it("ACK-REC-01/closed-first-vs-replay: first refuses while authorized historical evidence remains readable",()=>{
 for(const existing of [false,true]){
  const w=ackWorld();const first=existing?recordDeliveryAck(w.f.store,w.input,clockAt(10)):undefined;
  w.f.store.database.prepare("UPDATE exchange SET state='CLOSED',closed_at=? WHERE exchange_id=?").run(clockAt(11).now(),w.exchangeId);
  const before=snapshot(w.f),n=changes(w.f);
  if(existing){expect(recordDeliveryAck(w.f.store,w.input,clockAt(12))).toEqual({...first,disposition:"REPLAYED"});expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(12))).toEqual({...first,disposition:"COMMITTED"});}
  else expectRefusal(()=>recordDeliveryAck(w.f.store,w.input,clockAt(12)),"EXCHANGE_DISPOSITION_REJECTED");
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
 }
});
it("ACK-REC-01/join-boundary: exact creation must be strictly after recipient join",()=>{
 const w=ackWorld(),db=w.f.store.database;
 db.exec("DROP TRIGGER exchange_membership_immutable");
 db.prepare("UPDATE exchange_membership SET join_boundary_seq=? WHERE participant_id=?").run(w.input.messageCreatedAuditSequence,w.recipient);
 const before=snapshot(w.f),n=changes(w.f);
 expectRefusal(()=>recordDeliveryAck(w.f.store,w.input,clockAt(10)),"MESSAGE_READ_REJECTED");
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
it("ACK-REC-01/wrong-recipient: another valid owner cannot acknowledge or query recipient evidence",()=>{
 const w=ackWorld();recordDeliveryAck(w.f.store,w.input,clockAt(10));
 const input={...w.input,participantId:w.sender,sessionId:SENDER,capability:capabilityFor(w.f,w.sender,"ack",{sessionId:SENDER})};
 const before=snapshot(w.f),n=changes(w.f);
 for(const operation of [recordDeliveryAck,reconcileDeliveryAck])expectRefusal(()=>operation(w.f.store,input,clockAt(10)),"MESSAGE_READ_REJECTED");
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
const corruptions:[string,string][]=[
 ["body","UPDATE message SET payload_body=x'07070708'"],
 ["digest","UPDATE message SET payload_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
 ["length","UPDATE message SET payload_length=3"],
 ["creation-event","DROP TRIGGER audit_event_immutable; UPDATE audit_event SET outcome='tamper' WHERE kind='message_created'"],
];
for(const [variant,sql] of corruptions)it(`ACK-REC-01/body-creation-mismatch: ${variant}`,()=>{
 const w=ackWorld();w.f.store.database.exec(sql);const before=snapshot(w.f),n=changes(w.f);
 for(const operation of [recordDeliveryAck,reconcileDeliveryAck])expectRefusal(()=>operation(w.f.store,w.input,clockAt(10)),"STORAGE_IDEMPOTENCY_CORRUPT");
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
for(const variant of ["receipt-only","audit-only","duplicate-audit"])it(`ACK-REC-01/partial-evidence: ${variant} fails closed without repair`,()=>{
 const w=ackWorld(),db=w.f.store.database;recordDeliveryAck(w.f.store,w.input,clockAt(10));
 if(variant==="receipt-only")db.exec("DROP TRIGGER audit_event_nodelete; DELETE FROM audit_event WHERE kind='receipt_recorded'");
 if(variant==="audit-only")db.exec("DROP TRIGGER delivery_ack_receipt_nodelete; DELETE FROM delivery_ack_receipt");
 if(variant==="duplicate-audit")db.prepare("INSERT INTO audit_event SELECT ?,exchange_id,sequence+1,kind,subject_id,created_at,digest,length,outcome,private_revision FROM audit_event WHERE kind='receipt_recorded'").run(generateEntityId("evt_"));
 const before=snapshot(w.f),n=changes(w.f);
 for(const operation of [recordDeliveryAck,reconcileDeliveryAck])expectRefusal(()=>operation(w.f.store,w.input,clockAt(11)),"STORAGE_IDEMPOTENCY_CORRUPT");
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
for(const [field,sql] of [
 ["subject","UPDATE audit_event SET subject_id='rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAZ' WHERE kind='receipt_recorded'"],
 ["kind","UPDATE audit_event SET kind='read' WHERE kind='receipt_recorded'"],
 ["digest","UPDATE audit_event SET digest=NULL WHERE kind='receipt_recorded'"],
 ["length","UPDATE audit_event SET length=5 WHERE kind='receipt_recorded'"],
 ["outcome","UPDATE audit_event SET outcome='read' WHERE kind='receipt_recorded'"],
 ["time","UPDATE audit_event SET created_at='2026-10-10T00:00:09.000Z' WHERE kind='receipt_recorded'"],
] as const)it(`ACK-REC-01/malformed-audit: exact ${field} validation`,()=>{
 const w=ackWorld(),db=w.f.store.database;recordDeliveryAck(w.f.store,w.input,clockAt(10));
 db.exec("DROP TRIGGER audit_event_immutable");db.exec(sql);const before=snapshot(w.f),n=changes(w.f);
 for(const operation of [recordDeliveryAck,reconcileDeliveryAck])expectRefusal(()=>operation(w.f.store,w.input,clockAt(11)),"STORAGE_IDEMPOTENCY_CORRUPT");
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
it("ACK-REC-01/partial-evidence: foreign-recipient receipt cannot be silently bypassed as absent natural key",()=>{
 const w=ackWorld(),db=w.f.store.database;recordDeliveryAck(w.f.store,w.input,clockAt(10));
 db.exec("DROP TRIGGER delivery_ack_receipt_immutable");
 db.prepare("UPDATE delivery_ack_receipt SET recipient_participant_id=?,ack_session_id=?").run(w.sender,SENDER);
 const before=snapshot(w.f),n=changes(w.f);
 for(const operation of [recordDeliveryAck,reconcileDeliveryAck])expectRefusal(()=>operation(w.f.store,w.input,clockAt(11)),"STORAGE_IDEMPOTENCY_CORRUPT");
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
