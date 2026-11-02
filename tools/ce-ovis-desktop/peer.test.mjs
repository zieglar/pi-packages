import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// Control the Pi tool boundary while executing the actual peer loop. No Cloud or desktop process.
for (const scenario of ['stop-after-read','stop-after-ack','next-before-ack','next-after-ack','replayed-result']) test(scenario, t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ce-peer-boundary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(name,data)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof data==='string'?data:JSON.stringify(data));};
  const tasks=[1,2].map(n=>({schemaVersion:1,taskId:`CE-OVIS-TEST-boundary-${n}`,target:'ovis-test-workspace',testOnly:true,text:'test',deadline:'2030-01-01T00:00:00Z'}));
  for(const [i,task] of tasks.entries())write(`task-${i}.json`,JSON.stringify(task));
  const config={modules:path.join(root,'modules'),runDirectory:root,testId:'boundary',deadline:new Date(Date.now()+5000).toISOString(),scenario,tasks:tasks.map((task,i)=>({taskId:task.taskId,taskFile:path.join(root,`task-${i}.json`),desktopConfig:path.join(root,'desktop.json'),taskPayloadSha256:createHash('sha256').update(JSON.stringify(task)).digest('hex')})),python:process.execPath,bridge:path.join(root,'desktop-stub.mjs')};
  write('config.json',config);write('publication.json',{sessionFile:'fixture',endpointId:'pi/test',chatgptEndpoint:'chatgpt/main'});
  fs.mkdirSync(path.join(root,'store'));
  const db=new DatabaseSync(path.join(root,'store/ce-store.sqlite'));
  db.exec('CREATE TABLE participant(participant_id TEXT,endpoint_adapter TEXT,endpoint_id TEXT); CREATE TABLE message(message_id TEXT,exchange_id TEXT,payload_digest TEXT,payload_length INTEGER,created_at TEXT); CREATE TABLE delivery_ack_receipt(receipt_id TEXT,message_id TEXT,exchange_id TEXT,recipient_participant_id TEXT,payload_digest TEXT,payload_length INTEGER,created_at TEXT); CREATE TABLE audit_event(exchange_id TEXT,sequence INTEGER,kind TEXT,subject_id TEXT)');
  db.close();
  write('modules/@zieglar/pi-chat-exchange/package.json',{version:'0.3.0',type:'module'});
  for(const [name,body] of Object.entries({'multi-session-policy':'export const readSelectedMultiSessionPolicy=()=>{},parseMultiSessionManifest=()=>{};','background-manager':'export const parseTunnelProfile=()=>{};','messaging-config':'export const publishMessagingGeneration=()=>{};','profile':'export const buildTunnelMcpCommand=()=>{};'}))write(`modules/@zieglar/pi-chat-exchange/dist/tunnel/${name}.js`,body);
  write('modules/@earendil-works/pi-coding-agent/package.json',{version:'1.3.0',type:'module'});
  write('modules/@earendil-works/pi-coding-agent/dist/index.js',`import fs from 'node:fs';
export const SessionManager={open:()=>({getBranch:()=>[]})};
export const SettingsManager={inMemory:()=>({})};
export class DefaultResourceLoader {async reload(){}getExtensions(){return {errors:[]};}}
export async function createAgentSession(){return {session:{bindExtensions:async()=>{},dispose(){},extensionRunner:{getAllRegisteredTools:()=>['ce_send','ce_inbox_list','ce_read_payload','ce_ack'].map(name=>({definition:{name}})),emit:async()=>{}}}};}
`);
  write('modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js',`import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const c=JSON.parse(fs.readFileSync(process.argv[3]));let scan=0,sends=0;
export const wrapRegisteredTool=tool=>({execute:async(_id,args)=>{
 const name=tool.definition.name;fs.appendFileSync(path.join(c.runDirectory,'calls.jsonl'),JSON.stringify({name,args})+'\\n');
 if(name==='ce_inbox_list')return {details:{messages:scan++===0?[]:[{messageId:'in-1'},{messageId:'in-2'}]}};
 if(name==='ce_read_payload'){
  if(c.scenario==='stop-after-read')fs.writeFileSync(path.join(c.runDirectory,'stop-request'),'stop');
  const i=args.messageId==='in-1'?0:1;return {details:{messageId:args.messageId,from:'chatgpt/main',payloadDigest:'0'.repeat(64),payloadLength:4,auditSequence:i+1},content:[{}, {text:fs.readFileSync(c.tasks[i].taskFile,'utf8')}]};
 }
 if(name==='ce_ack'){if(c.scenario==='stop-after-ack')fs.writeFileSync(path.join(c.runDirectory,'stop-request'),'stop');return {details:{receipt:{receiptId:'ack'}}};}
 if(name==='ce_send'){
  sends++;
  if(c.scenario==='next-after-ack'&&sends===1){
   const db=new DatabaseSync(path.join(c.runDirectory,'store/ce-store.sqlite'));
   db.exec("INSERT INTO participant VALUES('recipient','chatgpt','chatgpt/main'); INSERT INTO message VALUES('out-1','exchange','digest',4,'2026-11-02T00:00:00.000Z'); INSERT INTO message VALUES('in-2','exchange','next',4,'2026-11-02T00:00:02.000Z'); INSERT INTO delivery_ack_receipt VALUES('receipt','out-1','exchange','recipient','digest',4,'2026-11-02T00:00:01.000Z'); INSERT INTO audit_event VALUES('exchange',6,'receipt_recorded','receipt'); INSERT INTO audit_event VALUES('exchange',7,'message_created','in-2')");db.close();
  }
  if(sends===2)fs.writeFileSync(path.join(c.runDirectory,'stop-request'),'stop');
  return {details:{disposition:c.scenario==='replayed-result'?'REPLAYED':'CREATED',messageId:'out-'+sends}};
 }
}});
`);
  write('desktop-stub.mjs',`import fs from 'node:fs';import path from 'node:path';
const root=path.dirname(process.argv[1]);fs.appendFileSync(path.join(root,'desktop-calls'),'called\\n');
console.log(JSON.stringify({scriptState:'FINISHED',ovisState:'COMPLETED',submission:'OBSERVED',response:'test'}));
`);
  const result=spawnSync(process.execPath,[new URL('./ce-peer.mjs',import.meta.url).pathname,'run',path.join(root,'config.json')],{encoding:'utf8',timeout:8000});
  assert.equal(result.error,undefined,result.stderr);
  const calls=fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  if(scenario==='stop-after-read'||scenario==='stop-after-ack'){
    assert.equal(calls.filter(c=>c.name==='ce_ack').length,scenario==='stop-after-read'?0:1,'no CE operation may begin after stop');
    assert.equal(fs.existsSync(path.join(root,'desktop-calls')),false);
  }else{
    const expected=scenario==='next-after-ack'?2:1;
    assert.equal(fs.readFileSync(path.join(root,'desktop-calls'),'utf8').trim().split('\n').length,expected,'next task must not run before prior result receipt');
    assert.equal(calls.filter(c=>c.name==='ce_ack').length,expected);
    if(scenario==='next-before-ack')assert.equal(JSON.parse(fs.readFileSync(path.join(root,'peer-failure.json'))).reason,'PRIOR_RESULT_ACK_REQUIRED');
    if(scenario==='replayed-result')assert.equal(JSON.parse(fs.readFileSync(path.join(root,'peer-failure.json'))).reason,'RESULT_SEND_NOT_CREATED');
  }
});
