#!/usr/bin/env node
// Independent read-only evidence check; reception receipts do not prove completion.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadTasks} from './tasks.mjs';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = config.runDirectory;
const publication = JSON.parse(fs.readFileSync(path.join(root, 'publication.json')));
const db = new DatabaseSync(path.join(root, 'store/ce-store.sqlite'), {readOnly:true});
db.exec('PRAGMA query_only=ON');
try {
  const reports=[];
  for (const task of loadTasks(config)) {
    const received=JSON.parse(fs.readFileSync(path.join(task.recordRoot,'received.json')));
    const returned=JSON.parse(fs.readFileSync(path.join(task.recordRoot,'returned.json')));
    assert.equal(received.taskId,task.taskId);
    assert.equal(returned.result.taskId,task.taskId);
    assert.equal(returned.ceSend.disposition,'CREATED');
    assert.equal(returned.result.scriptState,'FINISHED');
    assert.equal(returned.result.submission,'OBSERVED');
    assert.equal(returned.result.ovisState,'COMPLETED');
    assert.equal(returned.result.response,JSON.parse(fs.readFileSync(task.taskFile)).text);
    const evidence=[];
    for (const id of [received.messageId,returned.ceSend.messageId]) {
      const message=db.prepare('SELECT message_id,from_endpoint_json,to_endpoint_json,payload_digest,payload_length,created_at FROM message WHERE message_id=?').get(id);
      assert(message);
      const receipt=db.prepare('SELECT receipt_id,message_id,payload_digest,payload_length,message_created_audit_seq,created_at FROM delivery_ack_receipt WHERE message_id=?').get(id);
      assert(receipt,'Actual reception receipt absent: do not promote SENT to ACKED');
      assert.equal(receipt.payload_digest,message.payload_digest);
      assert.equal(receipt.payload_length,message.payload_length);
      evidence.push({message,receipt});
    }
    assert.equal(JSON.parse(evidence[0].message.from_endpoint_json).endpointId,publication.chatgptEndpoint);
    assert.equal(JSON.parse(evidence[0].message.to_endpoint_json).endpointId,publication.endpointId);
    assert.equal(JSON.parse(evidence[1].message.from_endpoint_json).endpointId,publication.endpointId);
    assert.equal(JSON.parse(evidence[1].message.to_endpoint_json).endpointId,publication.chatgptEndpoint);
    assert.equal(evidence[0].message.payload_digest,task.taskPayloadSha256);
    assert.equal(evidence[1].message.payload_digest,createHash('sha256').update(JSON.stringify(returned.result)).digest('hex'));
    reports.push({taskId:task.taskId,ceTaskReception:'ACKED',scriptState:returned.result.scriptState,ovisState:'COMPLETED',ceResultReception:'ACKED',responseExact:true,evidence,checkedAt:new Date().toISOString(),chatgptSemanticConfirmation:'REQUIRED_SEPARATELY'});
  }
  if (reports.length>1) {
    for(let i=1;i<reports.length;i++) assert(reports[i-1].evidence[1].receipt.created_at <= reports[i].evidence[0].message.created_at,'Next task preceded prior ChatGPT reception ACK');
  }
  const report=config.tasks ? {runtimeSessionId:publication.runtimeSessionId,tasks:reports,serialAckOrderVerified:true} : reports[0];
  fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({tasks:reports.map(r=>r.taskId),ceBothDirections:'ACKED',ovisState:'COMPLETED',responseExact:true,serialAckOrderVerified:reports.length>1}));
} finally {db.close();}
