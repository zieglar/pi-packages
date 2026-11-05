// Explicit one-message intake. The caller supplies tools bound to its current Pi Session.
// This module registers no tools, Hooks, transport, Session or background loop.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {loadTasks, authorizeTask} from './tasks.mjs';
import {runDesktop} from './execution.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const metadataKeys = ['messageId','exchangeId','from','to','payloadDigest','payloadLength','createdAt','auditSequence'];
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

function parseData(text) {
  try {return JSON.parse(text);} catch {throw Error('INVALID_JSON_DATA');}
}

function privateDirectory(directory, create=false) {
  if (create) fs.mkdirSync(directory,{mode:0o700});
  const stat=fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid!==process.getuid() || (stat.mode & 0o077)) throw Error('PRIVATE_DIRECTORY_REQUIRED');
}

function readPrivate(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid!==process.getuid() || (stat.mode & 0o077) || stat.nlink!==1 || stat.size>1_048_576) throw Error('PRIVATE_FILE_REQUIRED');
    return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(fd));
  } finally {fs.closeSync(fd);}
}

function syncDirectory(directory) {
  const fd=fs.openSync(directory,fs.constants.O_RDONLY);
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}

function writeRecord(file, record, exclusive=false) {
  const temporary=exclusive ? file : file+'.'+randomUUID()+'.tmp';
  const fd=fs.openSync(temporary,fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  if (!exclusive) fs.renameSync(temporary,file);
  syncDirectory(path.dirname(file));
}

function validateMetadata(value, messageId, config, now) {
  if (!value || value.messageId!==messageId || value.exchangeId!==config.exchangeId || value.from!==config.from || value.to!==config.to ||
      !/^[0-9a-f]{64}$/.test(value.payloadDigest) || !Number.isSafeInteger(value.payloadLength) || value.payloadLength<1 || value.payloadLength>65536 ||
      !Number.isSafeInteger(value.auditSequence) || value.auditSequence<=config.afterAuditSequence) throw Error('MESSAGE_METADATA_DENIED');
  const created=timestamp(value.createdAt);
  if (!Number.isFinite(created) || created<timestamp(config.activatedAt) || created>now || now-created>config.maxAgeSeconds*1000) throw Error('MESSAGE_FRESHNESS_DENIED');
  return Object.fromEntries(metadataKeys.map(key=>[key,value[key]]));
}

function validateTask(task, desktop, now) {
  const keys=['deadline','schemaVersion','target','taskId','testOnly','text'];
  if (!task || Object.keys(task).sort().join()!==keys.join() || task.schemaVersion!==1 || task.testOnly!==false ||
      typeof task.taskId!=='string' || !/^CE-OVIS-TASK-[A-Za-z0-9-]{1,64}$/.test(task.taskId) ||
      typeof task.text!=='string' || !task.text.isWellFormed() || Buffer.byteLength(task.text)<1 || Buffer.byteLength(task.text)>4096 ||
      typeof task.target!=='string' || !Number.isFinite(timestamp(task.deadline)) || timestamp(task.deadline)<=now) throw Error('TASK_SCHEMA_DENIED');
  if (desktop.taskMode!=='execute' || desktop.allowedTaskId!==task.taskId || desktop.allowedTextSha256!==sha(task.text) ||
      desktop.conversation!==task.target+' 的对话' || !absolute(desktop.stateDir)) throw Error('DESKTOP_AUTHORIZATION_DENIED');
}

function evidence(value, taskId) {
  if (!value || value.taskId!==taskId || !['NOT_ATTEMPTED','UNKNOWN','OBSERVED'].includes(value.desktopSubmission) ||
      typeof value.agentProcessingObserved!=='boolean' || !['UNKNOWN','REPORTED'].includes(value.completionReport) || value.taskCompletion!=='UNVERIFIED') throw Error('INVALID_BRIDGE_EVIDENCE');
  return {taskId,desktopSubmission:value.desktopSubmission,agentProcessingObserved:value.agentProcessingObserved,
    completionReport:value.completionReport,taskCompletion:'UNVERIFIED'};
}

export function createIntake({config:input,getSessionId,callTool,desktopRunner=runDesktop,now=Date.now}) {
  // Local configuration is authority. CE payload never selects paths, tools or routes.
  const config=structuredClone(input);
  let tasks;
  function current() {
    if (getSessionId()!==config.runtimeSessionId) throw Error('SESSION_CHANGED');
  }
  async function call(name,messageId) {
    current();
    const result=await callTool(name,{messageId});
    current();
    if (!result || result.isError || result.details?.ok===false || result.details?.code) throw Error('CE_TOOL_REFUSED');
    return result;
  }
  return async function intake(messageId) {
    if (config.enabled!==true) throw Error('INTAKE_DISABLED');
    if (config.taskMode!=='execute' || !['runtimeSessionId','exchangeId','from','to'].every(key=>typeof config[key]==='string' && config[key]) ||
        !absolute(config.runDirectory) || !absolute(config.python) || !absolute(config.bridge) ||
        !Number.isFinite(timestamp(config.activatedAt)) || timestamp(config.activatedAt)>now() ||
        !Number.isSafeInteger(config.afterAuditSequence) || config.afterAuditSequence<0 ||
        !Number.isFinite(config.maxAgeSeconds) || config.maxAgeSeconds<=0 || config.maxAgeSeconds>300) throw Error('INVALID_INTAKE_CONFIG');
    if (typeof messageId!=='string' || !/^msg_[A-Za-z0-9_-]{1,128}$/.test(messageId)) throw Error('INVALID_MESSAGE_ID');
    current();
    tasks ??= loadTasks(config);
    const metadata=validateMetadata((await call('ce_read',messageId)).details,messageId,config,now());
    const payload=await call('ce_read_payload',messageId);
    const read=validateMetadata(payload.details,messageId,config,now());
    if (metadataKeys.some(key=>metadata[key]!==read[key])) throw Error('PAYLOAD_METADATA_MISMATCH');
    const text=payload.content?.[1]?.type==='text' ? payload.content[1].text : undefined;
    if (typeof text!=='string' || !text.isWellFormed() || Buffer.byteLength(text)!==read.payloadLength || sha(text)!==read.payloadDigest) throw Error('PAYLOAD_BYTES_MISMATCH');
    const authorized=authorizeTask(text,tasks);
    // Private local task bytes and desktop authority must still match at dispatch.
    if (readPrivate(authorized.taskFile)!==text) throw Error('LOCAL_TASK_FILE_DRIFT');
    const task=parseData(text), desktop=parseData(readPrivate(authorized.desktopConfig));
    validateTask(task,desktop,now());
    privateDirectory(config.runDirectory);
    const directory=path.join(config.runDirectory,'intake');
    try {privateDirectory(directory,true);} catch(error) {if (error.code!=='EEXIST') throw error;privateDirectory(directory);}
    // Persist the intake directory entry before records can authorize dispatch.
    syncDirectory(config.runDirectory);
    const messageFile=path.join(directory,'message-'+sha(messageId)+'.json');
    const taskFile=path.join(directory,'task-'+task.taskId+'.json');
    let saved;
    try {saved=JSON.parse(readPrivate(messageFile));} catch(error) {if(error.code!=='ENOENT')throw error;}
    if (saved) {
      const claim=parseData(readPrivate(taskFile));
      if (saved.version!==1 || saved.messageId!==messageId || saved.payloadDigest!==read.payloadDigest || saved.taskId!==task.taskId ||
          claim.messageId!==messageId || claim.payloadDigest!==read.payloadDigest || claim.taskId!==task.taskId ||
          !['ATTEMPTED_NO_REPLAY','BRIDGE_RETURNED','STOPPED_NO_REPLAY'].includes(saved.result?.status)) throw Error('ATTEMPT_RECORD_CONFLICT');
      return {...evidence(saved.result,task.taskId),status:saved.result.status};
    }
    // Existing bridge history is never treated as permission to retry through CE.
    try {
      privateDirectory(desktop.stateDir);
      try {fs.lstatSync(path.join(desktop.stateDir,task.taskId+'.json'));throw Error('BRIDGE_ALREADY_ATTEMPTED');}
      catch(error) {if(error.code!=='ENOENT')throw error;}
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    const record={version:1,messageId,payloadDigest:read.payloadDigest,taskId:task.taskId,
      result:{taskId:task.taskId,status:'ATTEMPTED_NO_REPLAY',desktopSubmission:'UNKNOWN',agentProcessingObserved:false,completionReport:'UNKNOWN',taskCompletion:'UNVERIFIED'}};
    current();
    // The exclusive task binding also refuses concurrent/different-message attempts.
    // A crash between these durable writes remains blocked by the task binding.
    try {writeRecord(taskFile,{messageId,payloadDigest:read.payloadDigest,taskId:task.taskId},true);}
    catch(error) {if(error.code==='EEXIST')throw Error('TASK_ALREADY_ATTEMPTED');throw error;}
    writeRecord(messageFile,record,true);
    const window={root:config.runDirectory,end:Math.min(timestamp(task.deadline),now()+300_000),stopped:()=>getSessionId()!==config.runtimeSessionId};
    try {
      current();
      const output=await desktopRunner({python:config.python,bridge:config.bridge,task:authorized,env:process.env,window});
      current();
      record.result={...evidence(JSON.parse(output),task.taskId),status:'BRIDGE_RETURNED'};
    } catch {
      // Dispatch may already have reached the desktop; never replay or expose diagnostics.
      record.result.status='STOPPED_NO_REPLAY';
    }
    writeRecord(messageFile,record);
    return record.result;
  };
}
