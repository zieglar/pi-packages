#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateReply} from './reply.mjs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const root=config.runDirectory;
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name)));
const publication=read('publication.json');
const db=new DatabaseSync(path.join(root,'store/ce-store.sqlite'),{readOnly:true});
db.exec('PRAGMA query_only=ON');
try{
 const rounds=[];
 for(const round of config.rounds){
  const sent=read(round.testId+'-sent.json');
  const wake=read(round.testId+'-wake.json');
  const reply=read(round.testId+'-reply.json');
  assert.equal(sent.sent.disposition,'CREATED');assert.equal(wake.noticeSubmission,'OBSERVED');
  validateReply(JSON.stringify(reply.reply),round,sent.sent.messageId);
  const evidence=[];
  for(const id of [sent.sent.messageId,reply.messageId]){
   const message=db.prepare('SELECT message_id,exchange_id,from_endpoint_json,to_endpoint_json,payload_digest,payload_length,payload_body,created_at FROM message WHERE message_id=?').get(id);
   assert(message);
   const receipt=db.prepare('SELECT receipt_id,ack_session_id,payload_digest,payload_length,created_at FROM delivery_ack_receipt WHERE message_id=?').get(id);assert(receipt);
   assert.equal(receipt.payload_digest,message.payload_digest);assert.equal(receipt.payload_length,message.payload_length);
   assert.equal(createHash('sha256').update(message.payload_body).digest('hex'),message.payload_digest);
   if(id===reply.messageId){
    const actualReply=validateReply(Buffer.from(message.payload_body).toString('utf8'),round,sent.sent.messageId);
    assert.deepEqual(actualReply,reply.reply);
   }
   delete message.payload_body;evidence.push({message,receipt});
  }
  assert.equal(JSON.parse(evidence[0].message.from_endpoint_json).endpointId,publication.endpointId);
  assert.equal(JSON.parse(evidence[0].message.to_endpoint_json).endpointId,publication.chatgptEndpoint);
  assert.equal(JSON.parse(evidence[1].message.from_endpoint_json).endpointId,publication.chatgptEndpoint);
  assert.equal(JSON.parse(evidence[1].message.to_endpoint_json).endpointId,publication.endpointId);
  assert.equal(evidence[0].message.payload_digest,createHash('sha256').update(JSON.stringify(sent.task)).digest('hex'));
  rounds.push({testId:round.testId,ceMessage:'CREATED',desktopNotice:'OBSERVED',actualCeReply:'READ_VALIDATED_ACKED',nonceMatches:true,evidence});
 }
 assert.equal(new Set(rounds.flatMap(r=>r.evidence.map(e=>e.message.exchange_id))).size,1);
 assert(rounds[0].evidence[1].receipt.created_at<=rounds[1].evidence[0].message.created_at);
 const report={handoff:'HANDOFF-CE-CHATGPT-WAKE-01',runtimeSessionId:publication.runtimeSessionId,rounds,serialPiAckBeforeNextSend:true,automaticDesktopTrigger:true,checkedAt:new Date().toISOString()};
 fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({rounds:rounds.length,ceReplyValidation:'PASS',desktopNotices:'OBSERVED',serialOrder:'PASS'}));
}finally{db.close();}
