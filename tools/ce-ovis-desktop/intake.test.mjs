import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createIntake} from './intake.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ovis-intake-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=Date.parse('2026-11-05T16:00:00Z');
  const task={schemaVersion:1,taskId:'CE-OVIS-TASK-unit',target:'test',testOnly:false,text:'执行本地已批准任务 🚀',deadline:new Date(now+60_000).toISOString(),...options.task};
  const body=JSON.stringify(task), taskFile=path.join(root,'task.json'), desktopConfig=path.join(root,'desktop.json');
  fs.writeFileSync(taskFile,body,{mode:0o600});
  fs.writeFileSync(desktopConfig,JSON.stringify({taskMode:'execute',allowedTaskId:task.taskId,allowedTextSha256:sha(task.text),conversation:'test 的对话',agentButtonPrefix:'pi: test ',stateDir:path.join(root,'bridge-state')}),{mode:0o600});
  const config={enabled:true,taskMode:'execute',runtimeSessionId:'current-session',exchangeId:'exchange',from:'chatgpt/main',to:'pi/current',activatedAt:new Date(now-5_000).toISOString(),afterAuditSequence:100,maxAgeSeconds:60,runDirectory:root,python:'/trusted/python',bridge:'/trusted/bridge.py',tasks:[{taskId:task.taskId,taskFile,desktopConfig,taskPayloadSha256:sha(body)}],...options.config};
  let session='current-session';
  const calls=[],runs=[];
  const metadata={messageId:'msg_unit',exchangeId:'exchange',from:'chatgpt/main',to:'pi/current',payloadDigest:sha(body),payloadLength:Buffer.byteLength(body),createdAt:new Date(now-1000).toISOString(),auditSequence:101,...options.metadata};
  const callTool=async (name,args)=>{
    calls.push({name,args});
    if(options.call) return options.call(name,args,{metadata,body,setSession:value=>{session=value;}});
    return {details:{...metadata},content:[{type:'text',text:'untrusted content'},{type:'text',text:body}]};
  };
  const desktopRunner=async args=>{
    runs.push(args);
    assert.ok(fs.readdirSync(path.join(root,'intake')).some(name=>name.startsWith('message-')),'durable attempt exists before dispatch');
    if(options.runner) return options.runner(args,{setSession:value=>{session=value;}});
    return JSON.stringify({taskId:task.taskId,desktopSubmission:'OBSERVED',agentProcessingObserved:true,completionReport:'REPORTED',taskCompletion:'UNVERIFIED'});
  };
  const restart=()=>createIntake({config,getSessionId:()=>session,callTool,desktopRunner,now:()=>now});
  const intake=restart();
  return {intake,restart,root,calls,runs,metadata,body,config,task,setSession:value=>{session=value;}};
}

test('current Session metadata/payload tools, durable dispatch and separate evidence',async t=>{
  const f=fixture(t);
  const result=await f.intake('msg_unit');
  assert.deepEqual(f.calls.map(c=>c.name),['ce_read','ce_read_payload']);
  assert.ok(f.calls.every(c=>JSON.stringify(c.args)==='{"messageId":"msg_unit"}'));
  assert.equal(result.desktopSubmission,'OBSERVED');
  assert.equal(result.agentProcessingObserved,true);
  assert.equal(result.completionReport,'REPORTED');
  assert.equal(result.taskCompletion,'UNVERIFIED');
  assert.deepEqual(await f.intake('msg_unit'),result);
  assert.equal(f.runs.length,1);
});

test('disabled by default; no CE tools or bridge',async t=>{
  const f=fixture(t,{config:{enabled:undefined}});
  await assert.rejects(f.intake('msg_unit'),/INTAKE_DISABLED/);
  assert.equal(f.calls.length,0);assert.equal(f.runs.length,0);
});

for(const metadata of [{to:'pi/other'},{from:'unknown'},{exchangeId:'other'},{messageId:'msg_wrong'},{auditSequence:100},{auditSequence:1.2},{createdAt:'2026-11-05T15:59:00Z'},{createdAt:'2026-11-05T16:00:01Z'},{payloadLength:70000},{payloadDigest:'bad'}]) {
  test('reject route, activation, freshness or malformed metadata '+JSON.stringify(metadata),async t=>{
    const f=fixture(t,{metadata});
    await assert.rejects(f.intake('msg_unit'));
    assert.equal(f.runs.length,0);assert.equal(f.calls.length,1);
  });
}

for(const stage of ['ce_read','ce_read_payload']) {
  test('CE refusal at '+stage+' cannot ACK or dispatch',async t=>{
    const f=fixture(t,{call:(name,args,{metadata,body})=>name===stage?{isError:true,details:{code:'CE_HOST_UNAVAILABLE',reason:'MESSAGE_READ_REJECTED'}}:{details:metadata,content:[{type:'text',text:'warning'},{type:'text',text:body}]}});
    await assert.rejects(f.intake('msg_unit'),/CE_TOOL_REFUSED/);
    assert.equal(f.runs.length,0);
  });
  test('Session switch after '+stage+' stops dispatch',async t=>{
    const f=fixture(t,{call:(name,args,{metadata,body,setSession})=>{
      if(name===stage)setSession('other');
      return {details:metadata,content:[{type:'text',text:'warning'},{type:'text',text:body}]};
    }});
    await assert.rejects(f.intake('msg_unit'),/SESSION_CHANGED/);
    assert.equal(f.runs.length,0);
  });
}

for(const mutation of ['digest','body','route','missing-details','invalid-unicode']) {
  test('payload bound to metadata '+mutation,async t=>{
    const f=fixture(t,{call:(name,args,{metadata,body})=>{
      if(name==='ce_read')return {details:metadata};
      return {details:mutation==='missing-details'?undefined:{...metadata,...(mutation==='digest'?{payloadDigest:'a'.repeat(64)}:{}),...(mutation==='route'?{to:'other'}:{})},content:[{type:'text',text:'warning'},{type:'text',text:mutation==='body'?body+' ':mutation==='invalid-unicode'?'\ud800':body}]};
    }});
    await assert.rejects(f.intake('msg_unit'));assert.equal(f.runs.length,0);
  });
}

for(const task of [{command:'/bin/sh'},{testOnly:true},{target:'other'},{schemaVersion:2}]) {
  test('even locally hashed payload cannot widen closed task authority '+JSON.stringify(task),async t=>{
    const f=fixture(t,{task});
    await assert.rejects(f.intake('msg_unit'));assert.equal(f.runs.length,0);
  });
}

test('local payload file drift refuses before dispatch',async t=>{
  const f=fixture(t);fs.writeFileSync(f.config.tasks[0].taskFile,'changed');
  await assert.rejects(f.intake('msg_unit'),/LOCAL_TASK_FILE_DRIFT/);assert.equal(f.runs.length,0);
});

test('another Message ID cannot replay task ID',async t=>{
  const f=fixture(t,{call:(name,args,{metadata,body})=>({details:{...metadata,messageId:args.messageId},content:[{type:'text',text:'warning'},{type:'text',text:body}]})});
  await f.intake('msg_unit');
  await assert.rejects(f.intake('msg_second'),/TASK_ALREADY_ATTEMPTED/);assert.equal(f.runs.length,1);
});

test('uncertain dispatch is persisted and never replayed',async t=>{
  const f=fixture(t,{runner:()=>{throw Error('private provider output');}});
  const first=await f.intake('msg_unit');
  assert.equal(first.status,'STOPPED_NO_REPLAY');
  assert.equal(first.desktopSubmission,'UNKNOWN');assert.equal(first.taskCompletion,'UNVERIFIED');
  assert.ok(!JSON.stringify(first).includes('private provider'));
  assert.deepEqual(await f.intake('msg_unit'),first);assert.equal(f.runs.length,1);
});

test('Session switch during runner leaves unknown, not success',async t=>{
  const f=fixture(t,{runner:(args,{setSession})=>{setSession('other');return '{}';}});
  const result=await f.intake('msg_unit');
  assert.equal(result.status,'STOPPED_NO_REPLAY');assert.equal(result.taskCompletion,'UNVERIFIED');
});

test('historical bridge journal cannot dispatch',async t=>{
  const f=fixture(t);const dir=path.join(f.root,'bridge-state');fs.mkdirSync(dir,{mode:0o700});
  fs.writeFileSync(path.join(dir,f.task.taskId+'.json'),'{}');
  await assert.rejects(f.intake('msg_unit'),/BRIDGE_ALREADY_ATTEMPTED/);assert.equal(f.runs.length,0);
});

for(const unsafe of ['permissions','symlink','corrupt']) {
  test('unsafe or corrupt intake state '+unsafe,async t=>{
    const f=fixture(t);const dir=path.join(f.root,'intake');
    if(unsafe==='symlink') fs.symlinkSync(f.root,dir);
    else {
      fs.mkdirSync(dir,{mode:0o700});
      if(unsafe==='permissions')fs.chmodSync(dir,0o755);
      else fs.writeFileSync(path.join(dir,'message-'+sha('msg_unit')+'.json'),'broken',{mode:0o600});
    }
    await assert.rejects(f.intake('msg_unit'));assert.equal(f.runs.length,0);
  });
}

test('simultaneous calls cause at most one bridge dispatch',async t=>{
  const f=fixture(t);
  await Promise.allSettled([f.intake('msg_unit'),f.intake('msg_unit')]);assert.equal(f.runs.length,1);
});

test('restart returns durable uncertain outcome without dispatch',async t=>{
  const f=fixture(t,{runner:()=>{throw Error('uncertain');}});
  const first=await f.intake('msg_unit');
  assert.deepEqual(await f.restart()('msg_unit'),first);assert.equal(f.runs.length,1);
});

test('crash after task binding but before message record cannot replay',async t=>{
  const f=fixture(t);const dir=path.join(f.root,'intake');fs.mkdirSync(dir,{mode:0o700});
  fs.writeFileSync(path.join(dir,'task-'+f.task.taskId+'.json'),JSON.stringify({messageId:'msg_unit',taskId:f.task.taskId,payloadDigest:sha(f.body)}),{mode:0o600});
  await assert.rejects(f.restart()('msg_unit'),/TASK_ALREADY_ATTEMPTED/);assert.equal(f.runs.length,0);
});

test('record content conflict and unsafe file cannot replay',async t=>{
  const f=fixture(t);await f.intake('msg_unit');
  const file=path.join(f.root,'intake','message-'+sha('msg_unit')+'.json');
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.payloadDigest='a'.repeat(64);
  fs.writeFileSync(file,JSON.stringify(saved));
  await assert.rejects(f.restart()('msg_unit'),/ATTEMPT_RECORD_CONFLICT/);
  fs.chmodSync(file,0o644);
  await assert.rejects(f.restart()('msg_unit'),/PRIVATE_FILE_REQUIRED/);assert.equal(f.runs.length,1);
});

test('intake uses execution helper and real bridge journal with fake desktop only',async t=>{
  const {runDesktop}=await import('./execution.mjs');
  const {execFileSync}=await import('node:child_process');
  const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
  const source=path.dirname(new URL(import.meta.url).pathname);
  const f=fixture(t,{runner:args=>runDesktop({...args,python,bridge:path.join(args.window.root,'harness.py'),window:{...args.window,end:Date.now()+5000}})});
  const desktopFile=f.config.tasks[0].desktopConfig;
  const desktop=JSON.parse(fs.readFileSync(desktopFile,'utf8'));
  fs.writeFileSync(desktopFile,JSON.stringify({...desktop,windowId:'w-1',maxWaitSeconds:1,pollSeconds:0.001}));
  fs.writeFileSync(path.join(f.root,'harness.py'),[
    'import sys, json, datetime',
    'from pathlib import Path',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, '+JSON.stringify(source)+')',
    'from test_bridge import bridge, Desktop',
    'config = json.loads(Path(sys.argv[sys.argv.index("--config")+1]).read_text())',
    'task = json.loads(Path(sys.argv[sys.argv.index("--task")+1]).read_text())',
    'bridge.time.time = lambda: datetime.datetime.fromisoformat(task["deadline"].replace("Z", "+00:00")).timestamp() - 10',
    'desktop = Desktop(bridge.prompt_for(task), "处理结果\\n" + bridge.end_marker(task))',
    'print(json.dumps(bridge.run_task(task, config, desktop)))',
  ].join('\n'),{mode:0o600});
  const result=await f.intake('msg_unit');
  assert.equal(result.status,'BRIDGE_RETURNED');assert.equal(result.completionReport,'REPORTED');
  assert.equal(result.taskCompletion,'UNVERIFIED');assert.equal(result.agentProcessingObserved,false);
  const journal=JSON.parse(fs.readFileSync(path.join(f.root,'bridge-state',f.task.taskId+'.json'),'utf8'));
  assert.equal(journal.stage,'FINISHED');assert.equal(journal.result.submission,'OBSERVED');
  assert.deepEqual(await f.restart()('msg_unit'),result);assert.equal(f.runs.length,1);
});

for (const existing of [false,true]) {
  test('parent directory sync precedes durable records and dispatch; existing='+existing,async t=>{
    const events=[],sync=fs.fsyncSync;
    const f=fixture(t,{runner:()=>{
      events.push('dispatch');
      return JSON.stringify({taskId:f.task.taskId,desktopSubmission:'OBSERVED',agentProcessingObserved:false,completionReport:'REPORTED',taskCompletion:'UNVERIFIED'});
    }});
    if(existing)fs.mkdirSync(path.join(f.root,'intake'),{mode:0o700});
    const rootStat=fs.statSync(f.root);
    t.mock.method(fs,'fsyncSync',fd=>{
      const stat=fs.fstatSync(fd);
      events.push(stat.dev===rootStat.dev && stat.ino===rootStat.ino ? 'parent' : stat.isDirectory() ? 'intake' : 'record');
      return sync(fd);
    });
    const result=await f.intake('msg_unit');
    assert.equal(result.status,'BRIDGE_RETURNED');
    assert.ok(events.indexOf('parent')>=0,'parent directory must be synced');
    assert.ok(events.indexOf('parent')<events.indexOf('record'),'parent sync precedes record persistence');
    assert.deepEqual(events.slice(0,events.indexOf('dispatch')),['parent','record','intake','record','intake']);
  });

  test('parent sync failure refuses dispatch; existing='+existing,async t=>{
    const f=fixture(t),sync=fs.fsyncSync,rootStat=fs.statSync(f.root);
    if(existing)fs.mkdirSync(path.join(f.root,'intake'),{mode:0o700});
    t.mock.method(fs,'fsyncSync',fd=>{
      const stat=fs.fstatSync(fd);
      if(stat.dev===rootStat.dev && stat.ino===rootStat.ino)throw Error('DIRECTORY_SYNC_FAILED');
      return sync(fd);
    });
    await assert.rejects(f.intake('msg_unit'),/DIRECTORY_SYNC_FAILED/);
    assert.equal(f.runs.length,0);
  });
}
