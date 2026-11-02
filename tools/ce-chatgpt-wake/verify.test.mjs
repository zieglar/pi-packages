import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';

for(const mismatch of [false,true])test(`Store reply body ${mismatch?'mismatch rejected':'matches accepted'}`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ce-wake-verify-'));
 try{
  fs.mkdirSync(path.join(root,'store'));
  const db=new DatabaseSync(path.join(root,'store/ce-store.sqlite'));
  db.exec('CREATE TABLE message(message_id TEXT,exchange_id TEXT,from_endpoint_json TEXT,to_endpoint_json TEXT,payload_digest TEXT,payload_length INTEGER,payload_body BLOB,created_at TEXT); CREATE TABLE delivery_ack_receipt(receipt_id TEXT,message_id TEXT,ack_session_id TEXT,payload_digest TEXT,payload_length INTEGER,created_at TEXT)');
  const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  const rounds=[1,2].map(n=>({testId:`CE-WAKE-TEST-verify-${n}`,nonce:`nonce-${n}`}));
  write('config.json',{runDirectory:root,rounds});
  write('publication.json',{endpointId:'pi/test',chatgptEndpoint:'chatgpt/main',runtimeSessionId:'runtime-test'});
  for(const [i,round] of rounds.entries()){
   const task={...round},taskId=`task-${i}`,replyId=`reply-${i}`;
   const reply={schemaVersion:1,...round,inReplyTo:taskId};
   write(round.testId+'-sent.json',{task,sent:{disposition:'CREATED',messageId:taskId}});
   write(round.testId+'-wake.json',{noticeSubmission:'OBSERVED'});
   write(round.testId+'-reply.json',{messageId:replyId,reply});
   for(const isReply of [false,true]){
    const payload=Buffer.from(JSON.stringify(isReply?(mismatch?{...reply,nonce:'wrong'}:reply):task));
    const digest=createHash('sha256').update(payload).digest('hex');
    const id=isReply?replyId:taskId,from=isReply?'chatgpt/main':'pi/test',to=isReply?'pi/test':'chatgpt/main';
    db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)').run(id,'exchange',JSON.stringify({endpointId:from}),JSON.stringify({endpointId:to}),digest,payload.length,payload,`${i*4+(isReply?2:0)}`);
    db.prepare('INSERT INTO delivery_ack_receipt VALUES(?,?,?,?,?,?)').run('receipt-'+id,id,'ce-session',digest,payload.length,`${i*4+(isReply?3:1)}`);
   }
  }
  db.close();
  const result=spawnSync(process.execPath,[new URL('./verify.mjs',import.meta.url).pathname,path.join(root,'config.json')],{encoding:'utf8'});
  if(mismatch){assert.notEqual(result.status,0);assert.equal(fs.existsSync(path.join(root,'verification.json')),false);}
  else{assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'verification.json'))).rounds.length,2);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
