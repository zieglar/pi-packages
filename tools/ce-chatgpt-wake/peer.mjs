#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runDesktop,requireRunning} from '../ce-ovis-desktop/execution.mjs';
import {validateReply} from './reply.mjs';
process.umask(0o077);
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(const field of ['runDirectory','modules','desktopConfig','python','bridge']) {
 if(typeof config[field]!=='string'||!path.isAbsolute(config[field]))throw Error('ABSOLUTE_PATH_REQUIRED_'+field);
}
const desktopConfig=JSON.parse(fs.readFileSync(config.desktopConfig,'utf8'));
if(typeof desktopConfig.targetEndpoint!=='string'||!/^chatgpt\/[A-Za-z0-9-]{1,64}$/.test(desktopConfig.targetEndpoint)||typeof desktopConfig.replyEndpoint!=='string'||!/^pi\/[A-Za-z0-9-]{1,64}$/.test(desktopConfig.replyEndpoint))throw Error('DESKTOP_ENDPOINT_AUTHORIZATION_REQUIRED');
const root=config.runDirectory;
const publication=JSON.parse(fs.readFileSync(path.join(root,'publication.json')));
if(desktopConfig.targetEndpoint!==publication.chatgptEndpoint||desktopConfig.replyEndpoint!==publication.endpointId)throw Error('DESKTOP_ENDPOINT_AUTHORIZATION_MISMATCH');
const ce=path.join(config.modules,'@zieglar/pi-chat-exchange');
const pi=path.join(config.modules,'@earendil-works/pi-coding-agent');
const load=p=>import(pathToFileURL(p).href);
const write=(name,value)=>{const p=path.join(root,name);const fd=fs.openSync(p+'.tmp',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(p+'.tmp',p);};
if(JSON.parse(fs.readFileSync(ce+'/package.json')).version!=='0.3.0'||JSON.parse(fs.readFileSync(pi+'/package.json')).version!=='1.3.0')throw Error('RUNTIME_VERSION_MISMATCH');
if(!Array.isArray(config.rounds)||config.rounds.length!==2||new Set(config.rounds.map(r=>r.testId)).size!==2)throw Error('TWO_FIXED_ROUNDS_REQUIRED');
const end=Date.parse(config.deadline);
if(!Number.isFinite(end)||end<=Date.now()||end-Date.now()>900000)throw Error('BOUNDED_WINDOW_REQUIRED');
let stop=false;for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stop=true;});
const window={root,end,stopped:()=>stop};
const {SessionManager,SettingsManager,DefaultResourceLoader,createAgentSession}=await load(pi+'/dist/index.js');
const settingsManager=SettingsManager.inMemory({extensions:[],packages:[],cacheWarming:{enabled:false}});
const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:path.join(root,'agent'),settingsManager,noExtensions:true,additionalExtensionPaths:[ce+'/pi-extension/index.ts'],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
await resourceLoader.reload();if(resourceLoader.getExtensions().errors.length)throw Error('CE_EXTENSION_LOAD_FAILED');
const sessionManager=SessionManager.open(publication.sessionFile);
if(sessionManager.getBranch().some(e=>e.customType==='ce-messaging-released'))throw Error('SESSION_ENDED_PREPARE_NEW_WINDOW');
const {session}=await createAgentSession({cwd:root,agentDir:path.join(root,'agent'),sessionManager,settingsManager,resourceLoader,tools:[]});
const {wrapRegisteredTool}=await load(pi+'/dist/core/extensions/wrapper.js');
let sequence=0;
async function call(name,args){
 requireRunning(window);
 const tool=session.extensionRunner.getAllRegisteredTools().find(t=>t.definition.name===name);
 if(!tool||!['ce_send','ce_read_payload','ce_inbox_list','ce_ack'].includes(name))throw Error('CE_TOOL_UNAVAILABLE');
 const result=await wrapRegisteredTool(tool,session.extensionRunner).execute(config.testId+'/'+(++sequence),args,undefined,undefined);
 if(result.isError||result.details?.ok===false)throw Error('CE_TOOL_REFUSED_'+name);
 return result;
}
let cursor=0;
try{
 await session.bindExtensions({mode:'rpc',onError:()=>{stop=true;}});
 await call('ce_inbox_list',{afterAuditSequence:0,pageSize:1,rawScanLimit:1});
 write('peer-ready.json',{actualPiSession:true,ceVersion:'0.3.0',deadline:config.deadline});
 while(!fs.existsSync(path.join(root,'start-request'))){requireRunning(window);await new Promise(r=>setTimeout(r,200));}
 for(const round of config.rounds){
  requireRunning(window);
  if(!/^CE-WAKE-TEST-[A-Za-z0-9-]{1,64}$/.test(round.testId)||typeof round.nonce!=='string'||round.nonce.length>100)throw Error('FIXED_ROUND_DENIED');
  const attempt=path.join(root,round.testId+'-send-attempt.json');
  fs.writeFileSync(attempt,JSON.stringify({testId:round.testId,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  const task={schemaVersion:1,testId:round.testId,nonce:round.nonce,instruction:'仅通过 CE 回复此测试：先实际读取并记录接收 ACK，再 ce_send 回复发送方。回复必须是 JSON，且只有 schemaVersion:1、testId:本测试ID、nonce:本消息nonce、inReplyTo:本消息实际Message ID 四个字段。不要执行任何其他业务操作。'};
  const sent=(await call('ce_send',{to:publication.chatgptEndpoint,text:JSON.stringify(task),idempotencyKey:round.testId+':task'})).details;
  write(round.testId+'-sent.json',{task,sent,at:new Date().toISOString()});
  if(sent.disposition!=='CREATED')throw Error('CE_CREATED_REQUIRED');
  const record={testId:round.testId,messageId:sent.messageId,to:publication.chatgptEndpoint,replyTo:publication.endpointId,disposition:sent.disposition};
  const recordFile=path.join(root,round.testId+'-record.json');fs.writeFileSync(recordFile,JSON.stringify(record),{flag:'wx',mode:0o600});
  const stdout=await runDesktop({python:config.python,bridge:config.bridge,task:{desktopConfig:config.desktopConfig,taskFile:recordFile},env:process.env,window});
  const wake=JSON.parse(stdout);write(round.testId+'-wake.json',wake);
  if(wake.noticeSubmission!=='OBSERVED')throw Error('NOTICE_NOT_OBSERVED');
  let completed=false;
  while(!completed){
   requireRunning(window);
   const inbox=(await call('ce_inbox_list',{afterAuditSequence:cursor,pageSize:20,rawScanLimit:200})).details;
   for(const message of inbox.messages??[]){
    const read=await call('ce_read_payload',{messageId:message.messageId});
    if(read.details.from!==publication.chatgptEndpoint)throw Error('UNEXPECTED_REPLY_SENDER');
    const reply=validateReply(read.content[1]?.text,round,sent.messageId);
    const ack=(await call('ce_ack',{messageId:read.details.messageId,payloadDigest:read.details.payloadDigest,payloadLength:read.details.payloadLength,messageCreatedAuditSequence:read.details.auditSequence})).details;
    write(round.testId+'-reply.json',{messageId:message.messageId,reply,ack,readMetadata:read.details,at:new Date().toISOString()});completed=true;
   }
   cursor=inbox.continuationAuditSequence??cursor;
   if(!completed)await new Promise(r=>setTimeout(r,1000));
  }
 }
 write('completed.json',{rounds:2,actualCeRepliesReadAndAcked:true,at:new Date().toISOString()});
}catch(error){write('peer-failure.json',{reason:error.message,noAutomaticReplay:true});process.exitCode=1;}
finally{await session.extensionRunner.emit({type:'session_shutdown',reason:'shutdown'});session.dispose();write('peer-closed.json',{at:new Date().toISOString()});}
