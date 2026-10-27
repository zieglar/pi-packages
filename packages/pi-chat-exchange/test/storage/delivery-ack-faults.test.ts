import { afterEach, expect, it } from "vitest";
import { recordDeliveryAck, reconcileDeliveryAck } from "../../src/storage/delivery-ack.js";
import { CreationDomainError } from "../../src/storage/creation.js";
import { openStore } from "../../src/storage/store.js";
import { cleanupFixtures } from "./support/participant-fixture.js";
import { ackWorld, snapshot,clockAt } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
for(const [id,seam] of [["before-insert","beforeReceiptInsert"],["between-receipt-audit","afterReceiptInsert"],["before-commit","afterAuditInsert"]] as const)it(`ACK-TX-01/${id}: proven callback rollback with independent full-row proof`,()=>{
 const w=ackWorld(),before=snapshot(w.f);let calls=0;
 let error:unknown;try{recordDeliveryAck(w.f.store,w.input,{...clockAt(10),[seam]:()=>{calls++;throw Object.assign(new Error("PRIVATE_SENTINEL"),{errcode:5});}});}catch(e){error=e;}
 expect(calls).toBe(1);expect(error).toMatchObject({stage:"callback",outcome:"ROLLED_BACK",retryable:false});
 expect(JSON.stringify(error)).not.toContain("PRIVATE_SENTINEL");expect((error as Error).cause).toBeUndefined();
 expect(snapshot(w.f)).toBe(before);
 expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(11))).toEqual({disposition:"NO_TRACE"});
});
it("ACK-TX-01/commit-busy-active: exact commit-stage rollback, no hidden retry",()=>{
 const w=ackWorld(),db=w.f.store.database,exec=db.exec,before=snapshot(w.f);let commits=0;
 db.exec=((sql:string)=>{if(sql==="COMMIT"){commits++;throw Object.assign(new Error("PRIVATE_SENTINEL"),{errcode:5});}exec.call(db,sql);}) as typeof exec;
 try{expect(()=>recordDeliveryAck(w.f.store,w.input,clockAt(10))).toThrowError(expect.objectContaining({stage:"commit",outcome:"ROLLED_BACK",retryable:true}));}finally{db.exec=exec;}
 expect(commits).toBe(1);expect(snapshot(w.f)).toBe(before);
});
for(const kind of ["rollback-uncertain","commit-uncertain"])it(`ACK-TX-01/${kind}: poisoned old handle and independent authorized diagnosis`,()=>{
 const w=ackWorld(),db=w.f.store.database,exec=db.exec;
 db.exec=((sql:string)=>{
  if(kind==="rollback-uncertain"&&sql==="ROLLBACK")throw new Error("PRIVATE_SENTINEL");
  exec.call(db,sql);if(kind==="commit-uncertain"&&sql==="COMMIT")throw new Error("PRIVATE_SENTINEL");
 }) as typeof exec;
 expect(()=>recordDeliveryAck(w.f.store,w.input,{...clockAt(10),...(kind==="rollback-uncertain"?{afterReceiptInsert:()=>{throw new Error("PRIVATE_SENTINEL");}}:{})})).toThrowError(expect.objectContaining({outcome:"INDETERMINATE",retryable:false}));
 expect(()=>db.prepare("SELECT 1")).toThrow();
 const fresh=openStore({directory:w.f.directory,filename:w.f.filename});
 expect(reconcileDeliveryAck(fresh,w.input,clockAt(11)).disposition).toBe(kind==="commit-uncertain"?"COMMITTED":"NO_TRACE");fresh.close();
});
it("ACK-TX-01/commit-response-lost: confirmed storage return dropped, original IDs durable",()=>{
 const w=ackWorld();const result=recordDeliveryAck(w.f.store,w.input,clockAt(10));w.f.store.close();
 const fresh=openStore({directory:w.f.directory,filename:w.f.filename});
 expect(reconcileDeliveryAck(fresh,w.input,clockAt(11))).toEqual({...result,disposition:"COMMITTED"});fresh.close();
});
it("ACK-TX-01/before-insert: hostile hooks cannot inject domain errors or unsupported return behavior",()=>{
 const w=ackWorld(),before=snapshot(w.f);let touched=0;
 const hostile=new Proxy({}, {get(){touched++;throw new Error("PRIVATE_SENTINEL");}});
 for(const fail of [()=>{throw new CreationDomainError("IDEMPOTENCY_KEY_CONFLICT");},()=>hostile]){
  expect(()=>recordDeliveryAck(w.f.store,w.input,{...clockAt(10),beforeReceiptInsert:fail})).toThrowError(expect.objectContaining({code:"STORAGE_TRANSACTION_FAILED",stage:"callback",outcome:"ROLLED_BACK"}));
 }
 expect(touched).toBe(0);expect(snapshot(w.f)).toBe(before);
});
it("AUTHORITY-01/no-trace-no-approval: proved original rollback/quiescence still grants no second invocation",()=>{
 const w=ackWorld();let invocations=0;
 const original=()=>{invocations++;return recordDeliveryAck(w.f.store,w.input,{...clockAt(10),beforeReceiptInsert:()=>{throw new Error("deliberate original rollback");}});};
 expect(original).toThrowError(expect.objectContaining({stage:"callback",outcome:"ROLLED_BACK"}));
 const before=snapshot(w.f);
 expect(reconcileDeliveryAck(w.f.store,w.input,clockAt(11))).toEqual({disposition:"NO_TRACE"});
 expect(invocations).toBe(1);expect(snapshot(w.f)).toBe(before);
});
