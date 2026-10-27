import { afterEach,expect,it } from "vitest";
import { recordDeliveryAck } from "../../src/storage/delivery-ack.js";
import { discoverInboxMessages } from "../../src/storage/inbox-discovery.js";
import { capabilityFor,cleanupFixtures } from "./support/participant-fixture.js";
import { ackWorld,clockAt,S1,SENDER,snapshot,changes } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
for(const p of [1,2])it(`ISO-02/p${p}-k3: exact examined continuation through legitimate foreign and receipt interleaving`,()=>{
 const w=ackWorld(),read=capabilityFor(w.f,w.recipient,"read",{sessionId:S1});
 const after=w.input.messageCreatedAuditSequence-1;
 recordDeliveryAck(w.f.store,w.input,clockAt(10));
 const foreign=w.send(w.from);
 recordDeliveryAck(w.f.store,{...w.input,participantId:w.sender,sessionId:SENDER,capability:capabilityFor(w.f,w.sender,"ack",{sessionId:SENDER}),messageId:foreign.message.messageId,messageCreatedAuditSequence:foreign.auditSequence},clockAt(10));
 const m2=w.send();recordDeliveryAck(w.f.store,{...w.input,messageId:m2.message.messageId,messageCreatedAuditSequence:m2.auditSequence},clockAt(10));
 const m3=w.send();const before=snapshot(w.f),n=changes(w.f);
 let cursor=after;const ids:string[]=[],continuations:(number|null)[]=[],exhausted:boolean[]=[],pages:string[][]=[];
 for(let call=0;call<10;call++){
  const page=discoverInboxMessages(w.f.store,{participantId:w.recipient,sessionId:S1,fencingToken:1,capability:read,exchangeId:w.exchangeId,afterAuditSequence:cursor,pageSize:p,rawScanLimit:3},clockAt(10));
  const pageIds=page.messages.map(x=>x.message.messageId);ids.push(...pageIds);pages.push(pageIds);
  const next=page.continuationAuditSequence;
  continuations.push(next===null?null:next-after);exhausted.push(page.scanBudgetExhausted);
  if(next===null)break;expect(next).toBeGreaterThan(cursor);cursor=next;
 }
 expect(ids).toEqual([w.input.messageId,m2.message.messageId,m3.message.messageId]);expect(new Set(ids).size).toBe(ids.length);
 if(p===2){expect(pages).toEqual([[w.input.messageId],[m2.message.messageId],[m3.message.messageId],[]]);expect(continuations).toEqual([3,6,7,null]);expect(exhausted).toEqual([true,true,false,false]);}
 else expect(continuations[0]).toBe(1);
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
it("ISO-02/receipt-only-window: empty bounded page advances and next explicit request finds creation",()=>{
 const w=ackWorld(),read=capabilityFor(w.f,w.recipient,"read",{sessionId:S1});
 const prefix=[w.sent,w.send(),w.send()];const after=prefix.at(-1)!.auditSequence;
 for(const message of prefix)recordDeliveryAck(w.f.store,{...w.input,messageId:message.message.messageId,messageCreatedAuditSequence:message.auditSequence},clockAt(10));
 const tail=w.send(),before=snapshot(w.f),n=changes(w.f);
 const input={participantId:w.recipient,sessionId:S1,fencingToken:1,capability:read,exchangeId:w.exchangeId,afterAuditSequence:after,pageSize:2,rawScanLimit:3};
 const first=discoverInboxMessages(w.f.store,input,clockAt(10));
 expect(first).toEqual({messages:[],continuationAuditSequence:after+3,scanBudgetExhausted:true});
 const second=discoverInboxMessages(w.f.store,{...input,afterAuditSequence:first.continuationAuditSequence},clockAt(10));
 expect(second.messages.map(x=>x.message.messageId)).toEqual([tail.message.messageId]);
 expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
