import { afterEach,expect,it,vi } from "vitest";
import { recordDeliveryAck,reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { capabilityFor,cleanupFixtures,SECRET_HEX } from "./support/participant-fixture.js";
import { ackWorld,clockAt,S1,snapshot,changes } from "./support/delivery-ack-fixture.js";
afterEach(()=>{vi.restoreAllMocks();cleanupFixtures();});
it("ACK-REC-01/first-ack-and-reopen: PRIV synthetic body/credential/cause sink audit",()=>{
 const w=ackWorld(),body="PRIVATE_BODY_SENTINEL_do_not_echo",sent=w.send(w.endpoint,new TextEncoder().encode(body));
 const input={...w.input,messageId:sent.message.messageId,payloadDigest:sent.message.payloadDigest,payloadLength:sent.message.payloadLength,messageCreatedAuditSequence:sent.auditSequence};
 const sinks:unknown[]=[];
 for(const method of ["log","info","warn","error"] as const)vi.spyOn(console,method).mockImplementation((...args)=>{sinks.push(args);});
 const result=recordDeliveryAck(w.f.store,input,clockAt(10)),query=reconcileDeliveryAck(w.f.store,input,clockAt(11));
 const audit=w.f.store.database.prepare("SELECT * FROM audit_event WHERE kind='receipt_recorded'").all();
 const bad=capabilityFor(w.f,w.recipient,"send",{sessionId:S1});let error:unknown;
 try{reconcileDeliveryAck(w.f.store,{...input,capability:bad},clockAt(11));}catch(e){error=e;}
 expect(error).toMatchObject({code:"CAPABILITY_REJECTED"});expect((error as Error).cause).toBeUndefined();
 const rendered=JSON.stringify({result,query,audit,sinks,error,message:String(error)});
 for(const sentinel of [body,input.capability,bad,SECRET_HEX])expect(rendered).not.toContain(sentinel);
 expect(sinks).toEqual([]);
});
it("ACK-AUTH-01/valid-session-bound: closed defensive scalar capture resists post-capture mutation",()=>{
 const w=ackWorld(),input={...w.input};
 const result=recordDeliveryAck(w.f.store,input,{now:()=>{input.messageId="msg_01ARZ3NDEKTSV4RRFFQ69G5FAZ";input.payloadLength=999;input.capability="PRIVATE_CREDENTIAL_SENTINEL";return clockAt(10).now();}});
 expect(result.receipt.messageId).toBe(w.input.messageId);
});
it("ACK-AUTH-02/forged-token: inaccessible/unsupported input refuses without arbitrary values or writes",()=>{
 const w=ackWorld(),before=snapshot(w.f),n=changes(w.f);
 const accessor={...w.input};Object.defineProperty(accessor,"messageId",{enumerable:true,get(){throw new Error("PRIVATE_CAUSE_SENTINEL");}});
 const invalid=[{...w.input,unknown:"PRIVATE_CAUSE_SENTINEL"},{...w.input,payloadLength:1.5},{...w.input,payloadDigest:"G".repeat(64)},{...w.input,messageCreatedAuditSequence:0},accessor];
 for(const input of invalid)for(const operation of [recordDeliveryAck,reconcileDeliveryAck]){
  let error:unknown;try{operation(w.f.store,input,clockAt(10));}catch(e){error=e;}
  expect(error).toMatchObject({code:"STORAGE_PARTICIPANT_REQUEST_INVALID"});expect(String(error)).not.toContain("PRIVATE_CAUSE_SENTINEL");expect((error as Error).cause).toBeUndefined();
 }
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
