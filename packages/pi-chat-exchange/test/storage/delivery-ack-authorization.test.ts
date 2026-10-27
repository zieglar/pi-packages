import { afterEach, expect, it } from "vitest";
import { recordDeliveryAck, reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { detachSession, releaseOwnership, acquireOwnership } from "../../src/storage/ownership.js";
import { revokeCapability } from "../../src/storage/participant.js";
import { cleanupFixtures, capabilityFor, expectRefusal } from "./support/participant-fixture.js";
import { ackWorld, S1,S2,S3,clockAt,at,snapshot,changes,type AckWorld } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
const invalids: [string,string,(w:AckWorld)=>Partial<AckWorld["input"]>,number][] = [
  ["bound-nonowner","OWNERSHIP_NOT_CURRENT",w=>({sessionId:S2,capability:capabilityFor(w.f,w.recipient,"ack",{sessionId:S2})}),10],
  ["detached","CAPABILITY_REJECTED",w=>{const capability=capabilityFor(w.f,w.recipient,"ack",{sessionId:S3});const resume=capabilityFor(w.f,w.recipient,"resume",{sessionId:S3});detachSession(w.f.store,{participantId:w.recipient,sessionId:S3,capability:resume},clockAt(2));return{sessionId:S3,capability};},10],
  ["unbound","CAPABILITY_REJECTED",()=>({sessionId:"ses_01ARZ3NDEKTSV4RRFFQ69G5FAZ"}),10],
  ["wrong-participant","CAPABILITY_REJECTED",w=>({participantId:w.sender}),10],
  ["stale-fence","FENCING_STALE",()=>({fencingToken:2}),10],
  ["expired-lease","LEASE_EXPIRED",()=>({}),121],
  ["exact-expiry","LEASE_EXPIRED",()=>({}),120],
  ["clock-regression","LEASE_CLOCK_REGRESSION",w=>{const resume=capabilityFor(w.f,w.recipient,"resume",{sessionId:S1});releaseOwnership(w.f.store,{participantId:w.recipient,sessionId:S1,fencingToken:1,capability:resume},clockAt(2));acquireOwnership(w.f.store,{participantId:w.recipient,sessionId:S1,capability:w.attach},clockAt(5));return{fencingToken:2};},4],
  ["revoked-token","CAPABILITY_REJECTED",w=>{revokeCapability(w.f.store,{participantId:w.recipient,sessionId:S1,scope:"ack",capability:w.input.capability},clockAt(6));return{};},10],
  ["expired-token","CAPABILITY_REJECTED",w=>({capability:capabilityFor(w.f,w.recipient,"ack",{sessionId:S1,expiresAt:at(9)})}),10],
  ["wrong-scope","CAPABILITY_REJECTED",w=>({capability:capabilityFor(w.f,w.recipient,"send",{sessionId:S1})}),10],
  ["forged-token","CAPABILITY_REJECTED",()=>({capability:`cap_${"ab".repeat(32)}`}),10],
];
for(const [variant,code,mutate,seconds] of invalids) for(const replay of [false,true]) {
  it(`ACK-AUTH-02/${variant}: ${replay?"existing receipt":"fresh"} refuses before every protected lookup`,()=>{
    const w=ackWorld();if(replay)recordDeliveryAck(w.f.store,w.input,clockAt(5));
    const input={...w.input,...mutate(w)};
    const before=snapshot(w.f),n=changes(w.f),sql:string[]=[];
    const db=w.f.store.database,prepare=db.prepare;
    db.prepare=((text:string)=>{sql.push(text);return prepare.call(db,text);}) as typeof prepare;
    try {
      for(const operation of [recordDeliveryAck,reconcileDeliveryAck]) expectRefusal(()=>operation(w.f.store,input,clockAt(seconds)),code);
      expect(sql.filter(s=>/FROM (message|delivery_ack_receipt|audit_event)\b/.test(s))).toEqual([]);
    } finally {db.prepare=prepare;}
    expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
  });
}
it("ACK-AUTH-01/tA-valid-commit-after-expiry + ACK-AUTH-01/next-call-expired: post-lock tA only",()=>{
  const w=ackWorld(),db=w.f.store.database;let seconds=119.999;let samples=0;
  const original=db.exec,trace:string[]=[];
  db.exec=((sql:string)=>{trace.push(sql);original.call(db,sql);}) as typeof original;
  try {
    const result=recordDeliveryAck(w.f.store,w.input,{now:()=>{expect(db.isTransaction).toBe(true);samples++;return at(seconds);},afterAuditInsert:()=>{seconds=121;}});
    expect(result.disposition).toBe("CREATED");expect(samples).toBe(1);
    expect(trace[0]).toBe("BEGIN IMMEDIATE");expect(trace.at(-1)).toBe("COMMIT");
    const before=snapshot(w.f),n=changes(w.f);
    expectRefusal(()=>recordDeliveryAck(w.f.store,w.input,clockAt(120)),"LEASE_EXPIRED");
    expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
  } finally {db.exec=original;}
});
it("ACK-REC-02/new-owner-replay + ACK-REC-02/old-owner-replay: retain original private provenance",()=>{
  const w=ackWorld();const first=recordDeliveryAck(w.f.store,w.input,clockAt(10));
  const resume=capabilityFor(w.f,w.recipient,"resume",{sessionId:S1});
  releaseOwnership(w.f.store,{participantId:w.recipient,sessionId:S1,fencingToken:1,capability:resume},clockAt(11));
  acquireOwnership(w.f.store,{participantId:w.recipient,sessionId:S2,capability:w.attach},clockAt(12));
  const newInput={...w.input,sessionId:S2,fencingToken:2,capability:capabilityFor(w.f,w.recipient,"ack",{sessionId:S2})};
  const before=snapshot(w.f),n=changes(w.f);
  expect(recordDeliveryAck(w.f.store,newInput,clockAt(13))).toEqual({...first,disposition:"REPLAYED"});
  expect(reconcileDeliveryAck(w.f.store,newInput,clockAt(13))).toEqual({...first,disposition:"COMMITTED"});
  expectRefusal(()=>recordDeliveryAck(w.f.store,w.input,clockAt(13)),"OWNERSHIP_NOT_CURRENT");
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
});
