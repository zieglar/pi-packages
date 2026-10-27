// Private real-process ACK/authority worker. No body/credential/error text emitted.
import { existsSync, renameSync, writeFileSync, writeSync } from 'node:fs';
const config = await new Promise(resolve=>process.once('message',resolve));
const emit = x=>writeSync(1,JSON.stringify(x)+'\n');
const idle=new Int32Array(new SharedArrayBuffer(4));
// Deterministic file-marker barrier (no sleeps as ordering evidence; the 5 ms
// wait only bounds CPU while polling for an explicit marker).
const awaitMarker=(path,label)=>{
 const deadline=Date.now()+30000;
 while(!existsSync(path)){
  if(Date.now()>deadline)throw new Error(`${label} timeout`);
  Atomics.wait(idle,0,0,5);
 }
};
let store;
try {
 const storage=await import(config.storeUrl);
 const ack=await import(config.ackUrl);
 const ownership=await import(config.ownershipUrl);
 const participant=await import(config.participantUrl);
 store=storage.openStore({directory:config.directory,filename:config.filename,busyTimeoutMs:config.busyTimeoutMs??1});
 if(config.announceBegin){
  // Observation-only shim on this worker's private connection: announce that
  // the owned transaction has reached BEGIN IMMEDIATE (i.e. every pre-lock step
  // has already run) before SQLite blocks on the writer lock.
  const db=store.database,exec=db.exec.bind(db);
  db.exec=sql=>{if(sql==='BEGIN IMMEDIATE')emit({event:'begin-entered'});return exec(sql);};
 }
 emit({event:'ready'});
 if(config.goPath)awaitMarker(config.goPath,'go barrier');
 else await new Promise(resolve=>process.once('message',resolve));
 const hold=()=>{
  emit({event:'boundary',transaction:store.database.isTransaction,
    receipts:store.database.prepare('SELECT count(*) AS n FROM delivery_ack_receipt').get().n,
    audits:store.database.prepare("SELECT count(*) AS n FROM audit_event WHERE kind='receipt_recorded'").get().n});
  awaitMarker(config.releasePath,'barrier');
 };
 let clockValues=[];
 const sample=()=>config.clockGate===undefined?config.now:(existsSync(config.clockGate.path)?config.clockGate.after:config.clockGate.before);
 const now=()=>{if(config.boundary==='after-begin')hold();const value=sample();clockValues.push(value);return value;};
 const attempt=(prefix)=>{
  clockValues=[];
  const changesBefore=store.database.prepare('SELECT total_changes() AS n').get().n;
  const observed=()=>({samples:clockValues.length,clockValues:[...clockValues],
    changes:store.database.prepare('SELECT total_changes() AS n').get().n-changesBefore});
  try {
   let result;
   if(config.operation==='release')result=ownership.releaseOwnership(store,config.request,{now});
   else if(config.operation==='takeover')result=ownership.takeoverOwnership(store,config.request,{now});
   else if(config.operation==='revoke')result=participant.revokeCapability(store,config.request,{now});
   else result=ack.recordDeliveryAck(store,config.request,{now,
     ...(config.boundary==='after-receipt'?{afterReceiptInsert:hold}:{}),
     ...(config.boundary==='after-audit'?{afterAuditInsert:hold}:{})});
   if(config.boundary==='after-commit')hold();
   return {event:`${prefix}result`,result,...observed()};
  } catch(error){
   return {event:`${prefix}error`,code:error?.code,stage:error?.stage,outcome:error?.outcome,retryable:error?.retryable,...observed()};
  }
 };
 emit({event:'attempting'});
 const first=attempt('');
 if(config.outcomePath){
  // Atomic publication for a peer whose event loop is blocked inside its own
  // owned transaction and therefore cannot read this worker's stdout.
  writeFileSync(`${config.outcomePath}.tmp`,JSON.stringify(first),{flag:'wx',mode:0o600});
  renameSync(`${config.outcomePath}.tmp`,config.outcomePath);
 }
 emit(first);
 if(config.secondAttempt){
  await new Promise(resolve=>process.once('message',resolve));
  emit(attempt('replay-'));
 }
} catch(error){
 emit({event:'error',code:error?.code,stage:error?.stage,outcome:error?.outcome,retryable:error?.retryable});
} finally {try{store?.close();}catch{} process.disconnect();}
