import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {requirePriorReceipt} from './receipt.mjs';

for(const scenario of ['valid','same-ms-valid','missing','late','same-ms-reversed','missing-message-audit','missing-receipt-audit','wrong-recipient','wrong-digest','wrong-exchange'])test(`prior receipt ${scenario}`,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ce-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'ce-store.sqlite');const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE participant(participant_id TEXT,endpoint_adapter TEXT,endpoint_id TEXT);
    CREATE TABLE message(message_id TEXT,exchange_id TEXT,payload_digest TEXT,payload_length INTEGER,created_at TEXT);
    CREATE TABLE delivery_ack_receipt(receipt_id TEXT,message_id TEXT,exchange_id TEXT,recipient_participant_id TEXT,payload_digest TEXT,payload_length INTEGER,created_at TEXT);
    CREATE TABLE audit_event(exchange_id TEXT,sequence INTEGER,kind TEXT,subject_id TEXT);`);
  db.prepare('INSERT INTO participant VALUES(?,?,?)').run('recipient','chatgpt',scenario==='wrong-recipient'?'chatgpt/other':'chatgpt/main');
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('result','exchange','digest',4,'2026-11-02T00:00:00.000Z');
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('next',scenario==='wrong-exchange'?'other':'exchange','next-digest',4,'2026-11-02T00:00:02.000Z');
  const receiptSequence=scenario==='late'?30:['same-ms-reversed','same-ms-valid'].includes(scenario)?21:10;
  if(scenario!=='missing')db.prepare('INSERT INTO delivery_ack_receipt VALUES(?,?,?,?,?,?,?)').run('receipt','result','exchange','recipient',scenario==='wrong-digest'?'wrong':'digest',4,['same-ms-reversed','same-ms-valid'].includes(scenario)?'2026-11-02T00:00:02.000Z':'2026-11-02T00:00:01.000Z');
  if(scenario!=='missing-message-audit')db.prepare("INSERT INTO audit_event VALUES('exchange',?,'message_created','next')").run(scenario==='same-ms-valid'?22:20);
  if(scenario!=='missing-receipt-audit')db.prepare("INSERT INTO audit_event VALUES('exchange',?,'receipt_recorded','receipt')").run(receiptSequence);
  db.close();
  const before=fs.readFileSync(file);
  if(['valid','same-ms-valid'].includes(scenario))assert.doesNotThrow(()=>requirePriorReceipt(file,'result','chatgpt/main','next'));
  else assert.throws(()=>requirePriorReceipt(file,'result','chatgpt/main','next'),/PRIOR_RESULT_ACK_REQUIRED/);
  assert.deepEqual(fs.readFileSync(file),before,'receipt gate must not write the Store');
});
