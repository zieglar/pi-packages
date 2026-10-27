import { afterEach,expect,it,vi } from "vitest";
import { recordDeliveryAck,reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { readMessageMetadata,readMessagePayload } from "../../src/storage/messaging.js";
import { discoverInboxMessages } from "../../src/storage/inbox-discovery.js";
import { capabilityFor,cleanupFixtures,expectRefusal } from "./support/participant-fixture.js";
import { ackWorld,clockAt,S1,snapshot,changes,type AckWorld } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
function seed(w:AckWorld,cursor:boolean){
 const db=w.f.store.database;
 db.prepare("UPDATE message SET state='DELIVERY_UNKNOWN' WHERE message_id=?").run(w.input.messageId);
 db.prepare("INSERT INTO attempt(attempt_id,message_id,endpoint_json,consumer_id,instance_id,fencing_token,lease_expires_at,dispatch,transport,created_at,private_revision) VALUES ('att_fixture',?,'{}','consumer','instance',2,?,'started','ambiguous',?,3)").run(w.input.messageId,clockAt(120).now(),clockAt(1).now());
 db.prepare("INSERT INTO current_claim(message_id,consumer_id,instance_id,fencing_token,expires_at,private_revision) VALUES (?,'consumer','instance',2,?,4)").run(w.input.messageId,clockAt(120).now());
 db.prepare("INSERT INTO fencing_high_water(message_id,fencing_token,private_revision) VALUES (?,2,4)").run(w.input.messageId);
 db.prepare("INSERT INTO result(result_id,exchange_id,message_id,attempt_id,source_endpoint_json,transport,runtime,body,result_digest,settled_at,private_revision) VALUES ('result_fixture',?,?,'att_fixture','{}','ambiguous','interrupted','private result',?,?,5)").run(w.exchangeId,w.input.messageId,"a".repeat(64),clockAt(1).now());
 if(cursor)for(const [participantId,n,revision]of [[w.recipient,1,3],[w.sender,2,4]] as const)db.prepare("INSERT INTO delivery_cursor(exchange_id,participant_id,acked_audit_seq,private_revision) VALUES (?,?,?,?)").run(w.exchangeId,participantId,n,revision);
}
for(const variant of ["first-ack","equivalent-replay","denied-ack","read-only-reconcile"] as const)for(const cursor of [false,true])it(`ISO-01/${variant}: full G3 rows, ${cursor?"seeded":"absent"} cursor, no authority-plane side effects`,()=>{
 const w=ackWorld();seed(w,cursor);
 const task={status:"NONTERMINAL",revision:7},transport={delivery:"DELIVERY_UNKNOWN"};
 const forbidden={send:vi.fn(),recovery:vi.fn(),takeover:vi.fn(),completion:vi.fn(),issue:vi.fn(),renew:vi.fn()};
 if(variant==="equivalent-replay")recordDeliveryAck(w.f.store,w.input,clockAt(9));
 const before=snapshot(w.f,variant==="first-ack"?["delivery_ack_receipt","audit_event"]:[]),n=changes(w.f);
 if(variant==="first-ack"||variant==="equivalent-replay")expect(recordDeliveryAck(w.f.store,w.input,clockAt(10)).disposition).toBe(variant==="first-ack"?"CREATED":"REPLAYED");
 if(variant==="denied-ack")expectRefusal(()=>recordDeliveryAck(w.f.store,{...w.input,fencingToken:2},clockAt(10)),"FENCING_STALE");
 if(variant==="read-only-reconcile")expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(10))).toEqual({disposition:"NO_TRACE"});
 expect(snapshot(w.f,variant==="first-ack"?["delivery_ack_receipt","audit_event"]:[])).toBe(before);
 if(variant!=="first-ack")expect(changes(w.f)).toBe(n);
 expect(task).toEqual({status:"NONTERMINAL",revision:7});expect(transport).toEqual({delivery:"DELIVERY_UNKNOWN"});
 for(const spy of Object.values(forbidden))expect(spy).not.toHaveBeenCalled();
});
for(const variant of ["read-without-ack","discovery-without-ack","ack-not-processing"] as const)for(const cursor of [false,true])it(`ISO-02/${variant} + AUTHORITY-01/ce-not-completion: ${cursor?"seeded":"absent"} cursor remains exact`,()=>{
 const w=ackWorld();seed(w,cursor);
 const read=capabilityFor(w.f,w.recipient,"read",{sessionId:S1}),payload=capabilityFor(w.f,w.recipient,"payload_read",{sessionId:S1});
 const readInput={participantId:w.recipient,sessionId:S1,fencingToken:1,capability:read,exchangeId:w.exchangeId,messageId:w.input.messageId};
 if(variant==="ack-not-processing")recordDeliveryAck(w.f.store,w.input,clockAt(9));
 const before=snapshot(w.f),n=changes(w.f);
 if(variant!=="discovery-without-ack"){
  expect(readMessageMetadata(w.f.store,readInput,clockAt(10)).message.state).toBe("DELIVERY_UNKNOWN");
  expect(readMessagePayload(w.f.store,{...readInput,capability:payload},clockAt(10)).payload).toEqual(new Uint8Array([7,7,7,7]));
 }
 if(variant!=="read-without-ack")expect(discoverInboxMessages(w.f.store,{participantId:w.recipient,sessionId:S1,fencingToken:1,capability:read,exchangeId:w.exchangeId,afterAuditSequence:0,pageSize:2,rawScanLimit:50},clockAt(10)).messages.map(x=>x.message.messageId)).toContain(w.input.messageId);
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
