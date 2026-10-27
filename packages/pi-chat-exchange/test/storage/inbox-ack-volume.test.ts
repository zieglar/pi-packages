import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach,expect,it } from "vitest";
import { canonicalDigest } from "../../src/protocol/idempotency.js";
import { encodeUlid, type EntityIdPrefix } from "../../src/protocol/identity.js";
import { discoverInboxMessages } from "../../src/storage/inbox-discovery.js";
import { capabilityFor,cleanupFixtures } from "./support/participant-fixture.js";
import { ackWorld,clockAt,S1,changes } from "./support/delivery-ack-fixture.js";
afterEach(cleanupFixtures);
function deterministicId(prefix: EntityIdPrefix,ordinal: number): string {
 const bytes=new Uint8Array(10);let value=BigInt(ordinal);
 for(let i=9;i>=0;i--){bytes[i]=Number(value&255n);value>>=8n;}
 return prefix+encodeUlid(0,bytes);
}
for(const ratio of [0,50,90,99])it(`ISO-02/current-volume-queryplan: lawful 100000-event ${ratio}% receipt window and bounded complete traversal`,()=>{
 const w=ackWorld(),db=w.f.store.database,now=clockAt(5).now(),ackTime=clockAt(10).now();
 const read=capabilityFor(w.f,w.recipient,"read",{sessionId:S1});
 const message=db.prepare("INSERT INTO message(message_id,exchange_id,from_endpoint_json,to_endpoint_json,state,payload_digest,payload_length,payload_body,created_at,idempotency_key,private_revision) VALUES (?,?,?,?,'CREATED',?,4,?,?,?,1)");
 const audit=db.prepare("INSERT INTO audit_event(event_id,exchange_id,sequence,kind,subject_id,created_at,digest,length,outcome,private_revision) VALUES (?,?,?,?,?,?,?,?,?,1)");
 const record=db.prepare("INSERT INTO idempotency_record(namespace,idempotency_key,request_digest,entity_id,created_at,private_revision) VALUES (?,?,?,?,?,1)");
 const receipt=db.prepare("INSERT INTO delivery_ack_receipt(receipt_id,exchange_id,message_id,recipient_participant_id,ack_session_id,ack_fencing_token,trust_generation,payload_digest,payload_length,message_created_audit_seq,created_at,private_revision) VALUES (?,?,?,?,?,1,1,?,4,?,?,1)");
 let sequence=Number(db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n),messageOrdinal=0,receiptOrdinal=0,eventOrdinal=0;
 const body=new Uint8Array([7,7,7,7]);let ordinal=0;
 const create=(to=w.endpoint)=>{
  const id=deterministicId("msg_",++messageOrdinal),key=`volume-${++ordinal}`;
  message.run(id,w.exchangeId,JSON.stringify(w.from),JSON.stringify(to),w.input.payloadDigest,body,now,key);
  record.run(JSON.stringify(["message.create",w.exchangeId]),key,canonicalDigest({op:"chat-exchange/message.create",v:1,exchangeId:w.exchangeId,from:w.from,to,payloadDigest:w.input.payloadDigest,payloadLength:4}),id,now);
  audit.run(deterministicId("evt_",++eventOrdinal),w.exchangeId,++sequence,"message_created",id,now,w.input.payloadDigest,4,null);
  return{id,sequence};
 };
 const prefix:{id:string;sequence:number}[]=[],oracle:string[]=[];
 db.exec("BEGIN IMMEDIATE");
 try{
  for(let i=0;i<ratio*1000;i++)prefix.push(create());
  const after=sequence;let receiptIndex=0;
  for(let i=0;i<100000;i++){
   if(i%100<ratio){const target=prefix[receiptIndex++]!,id=deterministicId("rcpt_",++receiptOrdinal);
    receipt.run(id,w.exchangeId,target.id,w.recipient,S1,w.input.payloadDigest,target.sequence,ackTime);
    audit.run(deterministicId("evt_",++eventOrdinal),w.exchangeId,++sequence,"receipt_recorded",id,ackTime,w.input.payloadDigest,4,"delivery_ack");
   }else {const visible=i%101===0;const created=create(visible?w.endpoint:w.from);if(visible)oracle.push(created.id);}
  }
  db.exec("COMMIT");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const range=db.prepare("EXPLAIN QUERY PLAN SELECT sequence,kind,subject_id FROM audit_event WHERE exchange_id=? AND sequence>? ORDER BY sequence LIMIT 2000").all(w.exchangeId,after);
  const correlation=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM audit_event WHERE exchange_id=? AND kind='receipt_recorded' AND subject_id=? LIMIT 2").all(w.exchangeId,"rcpt_unused");
  const natural=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM delivery_ack_receipt WHERE exchange_id=? AND message_id=? AND recipient_participant_id=?").all(w.exchangeId,w.input.messageId,w.recipient);
  const plans=JSON.stringify({range,correlation,natural});
  expect(plans).not.toMatch(/SCAN audit_event|SCAN delivery_ack_receipt|TEMP B-TREE/);
  expect(JSON.stringify(correlation)).toContain("idx_audit_event_correlation");expect(JSON.stringify(natural)).toContain("sqlite_autoindex_delivery_ack_receipt_2");
  const n=changes(w.f),observed:string[]=[],latencies:number[]=[],lockHeld:number[]=[];let cursor=after,pages=0,sqlCalls=0,lockStart=0;
  const prepare=db.prepare,exec=db.exec;
  db.exec=((sql:string)=>{exec.call(db,sql);if(sql==="BEGIN IMMEDIATE")lockStart=performance.now();if(sql==="COMMIT")lockHeld.push(performance.now()-lockStart);}) as typeof exec;
  db.prepare=((sql:string)=>{sqlCalls++;return prepare.call(db,sql);}) as typeof prepare;
  try{
   for(;;){const start=performance.now();const page=discoverInboxMessages(w.f.store,{participantId:w.recipient,sessionId:S1,fencingToken:1,capability:read,exchangeId:w.exchangeId,afterAuditSequence:cursor,pageSize:50,rawScanLimit:2000},clockAt(10));latencies.push(performance.now()-start);pages++;
    expect(page.messages.length).toBeLessThanOrEqual(50);observed.push(...page.messages.map(m=>m.message.messageId));
    if(page.continuationAuditSequence===null)break;
    expect(page.continuationAuditSequence-cursor).toBeLessThanOrEqual(2000);expect(page.continuationAuditSequence).toBeGreaterThan(cursor);cursor=page.continuationAuditSequence;
   }
  }finally{db.prepare=prepare;db.exec=exec;}
  expect(observed).toEqual(oracle);expect(new Set(observed).size).toBe(observed.length);expect(changes(w.f)).toBe(n);
  latencies.sort((a,b)=>a-b);lockHeld.sort((a,b)=>a-b);
  const metrics={descriptor:"ISO-02/current-volume-queryplan",ratio,rawWindow:100000,returned:observed.length,pages,sqlCalls,p50:latencies[Math.floor(latencies.length*.5)],p95:latencies[Math.floor(latencies.length*.95)],p95LockHeldMs:lockHeld[Math.floor(lockHeld.length*.95)],maxLockHeldMs:lockHeld.at(-1),plans,oracleHash:createHash("sha256").update(oracle.join("\n")).digest("hex")};
  console.info(JSON.stringify(metrics));
  const evidence=process.env.CE_E2A_VOLUME_EVIDENCE_DIR;
  if(evidence!==undefined)appendFileSync(join(evidence,"volume-measurements.jsonl"),JSON.stringify(metrics)+"\n",{mode:0o600});
 }catch(e){if(db.isTransaction)db.exec("ROLLBACK");throw e;}
},120000);
