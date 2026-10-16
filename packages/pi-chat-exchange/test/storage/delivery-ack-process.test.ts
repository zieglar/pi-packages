import { afterEach,expect,it } from "vitest";
import { recordDeliveryAck,reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { releaseOwnership,takeoverOwnership } from "../../src/storage/ownership.js";
import { revokeCapability } from "../../src/storage/participant.js";
import { openStore } from "../../src/storage/store.js";
import { capabilityFor,cleanupFixtures,expectRefusal } from "./support/participant-fixture.js";
import { ackWorld,clockAt,at,S1,S2,snapshot,changes } from "./support/delivery-ack-fixture.js";
import { launch, type WorkerEvent } from "./support/delivery-ack-process.js";
afterEach(cleanupFixtures);
for(const [variant,boundary,expected] of [["between-receipt-audit","after-receipt",[1,0]],["before-commit","after-audit",[1,1]],["restart-durable-pair","after-commit",[1,1]]] as const)it(`ACK-TX-01/${variant}: real SIGKILL at acknowledged boundary and proven exit before observer`,async()=>{
 const w=ackWorld(),before=snapshot(w.f,["delivery_ack_receipt","audit_event"]);
 const worker=await launch(w,{tag:variant,boundary,now:at(10)});
 try{worker.go();expect(await worker.wait("boundary")).toMatchObject({receipts:expected[0],audits:expected[1],transaction:boundary!=="after-commit"});
  expect(worker.child.kill("SIGKILL")).toBe(true);
  expect(await worker.done).toEqual({code:null,signal:"SIGKILL",stderr:""});
  expect(worker.events.some(e=>e.event==="result")).toBe(false);
  const fresh=openStore({directory:w.f.directory,filename:w.f.filename});
  expect(reconcileDeliveryAck(fresh,w.input,clockAt(11)).disposition).toBe(boundary==="after-commit"?"COMMITTED":"NO_TRACE");fresh.close();
  expect(snapshot(w.f,["delivery_ack_receipt","audit_event"])).toBe(before);
 }finally{if(worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill("SIGKILL");await worker.done;}}
},30000);
it("ACK-TX-01/no-trace-original-live + AUTHORITY-01/no-trace-live-original: query before original BEGIN cannot authorize retry",async()=>{
 const w=ackWorld();const worker=await launch(w,{tag:"live",now:at(10)});
 try{
  const before=snapshot(w.f),n=changes(w.f);
  expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(9))).toEqual({disposition:"NO_TRACE"});
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
  expect(worker.events).toEqual([{event:"ready"}]);
  worker.go();const result=(await worker.wait("result")).result;
  expect(await worker.done).toEqual({code:0,signal:null,stderr:""});
  expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(11))).toEqual({...result,disposition:"COMMITTED"});
  expect(worker.events.filter(e=>e.event==="attempting")).toHaveLength(1);
 }finally{if(worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill("SIGKILL");await worker.done;}}
},30000);
// a1-first: the worker process owns the writer lock inside its ACK transaction and the in-process caller is the loser.
// a2-first: the reverse order — the in-process caller owns the writer lock inside its ACK transaction (private
// afterReceiptInsert hook) while the worker's concurrent duplicate attempt is triggered and observed through
// deterministic file markers; the worker loses at BEGIN, then replays after the in-process winner commits.
for(const first of ["a1","a2"] as const)it(`ACK-REC-02/concurrent-${first}-first + ACK-TX-01/begin-busy: explicit duplicate order with held lock`,async()=>{
 const w=ackWorld();
 if(first==="a1"){
  const worker=await launch(w,{tag:first,boundary:"after-receipt",now:at(10)});
  try{worker.go();expect(await worker.wait("boundary")).toMatchObject({transaction:true,receipts:1});let samples=0;
   expect(()=>recordDeliveryAck(w.f.store,w.input,{now:()=>{samples++;return at(11);}})).toThrowError(expect.objectContaining({stage:"begin",outcome:"ROLLED_BACK",retryable:true}));
   expect(samples).toBe(0);worker.release();const result=(await worker.wait("result")).result;
   expect(await worker.done).toEqual({code:0,signal:null,stderr:""});
   const before=snapshot(w.f),n=changes(w.f);
   expect(recordDeliveryAck(w.f.store,w.input,clockAt(11))).toEqual({...result,disposition:"REPLAYED"});
   expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
  }finally{if(worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill("SIGKILL");await worker.done;}}
  return;
 }
 const loser=await launch(w,{tag:first,now:at(11),goByFile:true,outcomeFile:true,secondAttempt:true});
 try{
  expect(loser.events).toEqual([{event:"ready"}]);
  let held:{transaction:boolean;receipts:unknown;outcome:WorkerEvent}|undefined;
  const winner=recordDeliveryAck(w.f.store,w.input,{now:()=>at(10),afterReceiptInsert:()=>{
   // Inside the in-process owned transaction (writer lock held, receipt row inserted, uncommitted):
   // release the worker's duplicate attempt and block until it has published its terminal outcome.
   const transaction=w.f.store.database.isTransaction;
   const receipts=w.f.store.database.prepare("SELECT count(*) AS n FROM delivery_ack_receipt").get()!.n;
   held={transaction,receipts,outcome:loser.attemptWhileHeld()};
  }});
  expect(held).toBeDefined();
  expect(held!.transaction).toBe(true);expect(held!.receipts).toBe(1);
  expect(held!.outcome).toMatchObject({event:"error",stage:"begin",outcome:"ROLLED_BACK",retryable:true,samples:0,clockValues:[],changes:0});
  expect(await loser.wait("error")).toEqual(held!.outcome);
  expect(winner.disposition).toBe("CREATED");
  expect(loser.events.some(e=>e.event==="result")).toBe(false);
  const before=snapshot(w.f),n=changes(w.f);
  loser.go();const replay=await loser.wait("replay-result");
  expect(await loser.done).toEqual({code:0,signal:null,stderr:""});
  expect(replay.result).toEqual({...winner,disposition:"REPLAYED"});
  expect(replay).toMatchObject({samples:1,clockValues:[at(11)],changes:0});
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
 }finally{if(loser.child.exitCode===null&&loser.child.signalCode===null){loser.child.kill("SIGKILL");await loser.done;}}
},30000);
for(const operation of ["release","revoke","takeover"] as const)for(const order of ["ack-first","other-first"])for(const replay of [false,true])it(`ACK-AUTH-02/${operation}-both-orders: ${order}, ${replay?"replay":"fresh"}`,async()=>{
 const w=ackWorld();if(replay)recordDeliveryAck(w.f.store,w.input,clockAt(5));
 const request=operation==="release"?{participantId:w.recipient,sessionId:S1,fencingToken:1,capability:capabilityFor(w.f,w.recipient,"resume",{sessionId:S1})}:
  operation==="revoke"?{participantId:w.recipient,sessionId:S1,scope:"ack",capability:w.input.capability}:
  {participantId:w.recipient,sessionId:S2,capability:capabilityFor(w.f,w.recipient,"takeover",{sessionId:S2})};
 const otherNow=operation==="takeover"?120:11;
 const other=()=>operation==="release"?releaseOwnership(w.f.store,request,clockAt(otherNow)):operation==="revoke"?revokeCapability(w.f.store,request,clockAt(otherNow)):takeoverOwnership(w.f.store,request,clockAt(otherNow));
 const worker=await launch(w,{tag:`${operation}-${order}-${replay}`,operation:order==="ack-first"?"ack":operation,request:order==="ack-first"?w.input:request,now:at(order==="ack-first"?10:otherNow),boundary:"after-begin"});
 try{
  worker.go();await worker.wait("boundary");
  if(order==="ack-first")expect(other).toThrowError(expect.objectContaining({stage:"begin",outcome:"ROLLED_BACK"}));
  else expect(()=>recordDeliveryAck(w.f.store,w.input,clockAt(10))).toThrowError(expect.objectContaining({stage:"begin",outcome:"ROLLED_BACK"}));
  worker.release();await worker.wait("result");expect(await worker.done).toEqual({code:0,signal:null,stderr:""});
  if(order==="ack-first")other();
  const before=snapshot(w.f),n=changes(w.f);
  expectRefusal(()=>recordDeliveryAck(w.f.store,w.input,clockAt(otherNow)),operation==="revoke"?"CAPABILITY_REJECTED":"OWNERSHIP_NOT_CURRENT");
  expect(snapshot(w.f)).toBe(before);expect(changes(w.f)).toBe(n);
 }finally{if(worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill("SIGKILL");await worker.done;}}
},30000);
// The waiter's clock is state-dependent: it reads 119 (lease still valid) until the test opens the clock gate,
// which happens only after the waiter has provably reached BEGIN IMMEDIATE (`begin-entered`, so any pre-lock
// clock sample has already been taken) and immediately before the holder is released. Only a post-lock
// sample can therefore observe 120 (expired); a pre-lock sample would observe 119 and replay successfully.
it("ACK-AUTH-02/expired-while-waiting: post-lock clock refuses, never cached lock-before time",async()=>{
 // The holder parks inside its owned ACK transaction at the private afterReceiptInsert hook, which is
 // independent of where the clock is sampled, so the lock-held boundary itself cannot move with a clock mutation.
 const w=ackWorld();const holder=await launch(w,{tag:"holder",boundary:"after-receipt",now:at(119)});
 const waiter=await launch(w,{tag:"waiter",now:at(120),clockGate:{before:at(119),after:at(120)},announceBegin:true,busyTimeoutMs:5000});
 try{holder.go();expect(await holder.wait("boundary")).toMatchObject({transaction:true,receipts:1});
  waiter.go();await waiter.wait("begin-entered");
  expect(waiter.events.map(e=>e.event)).toEqual(["ready","attempting","begin-entered"]);
  waiter.openClockGate();holder.release();
  expect(await holder.wait("result")).toMatchObject({samples:1,clockValues:[at(119)],result:{disposition:"CREATED"}});expect(await holder.done).toEqual({code:0,signal:null,stderr:""});
  expect(await waiter.done).toEqual({code:0,signal:null,stderr:""});
  expect(waiter.events.filter(e=>e.event==="result"||e.event==="error")).toEqual([expect.objectContaining({event:"error",code:"LEASE_EXPIRED",samples:1,clockValues:[at(120)],changes:0})]);
 }finally{for(const worker of [holder,waiter])if(worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill("SIGKILL");await worker.done;}}
},30000);
