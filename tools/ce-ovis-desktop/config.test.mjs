import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Invalid local configuration must fail before any external runtime or side effect.
for(const [entry,args,config,expected] of [
  ['ce-peer.mjs',['prepare'],{modules:'relative',runDirectory:'/unused',existingProfile:'/unused',node:process.execPath},'ABSOLUTE_PATH_REQUIRED_modules'],
  ['ce-peer.mjs',['prepare'],{modules:'/unused',runDirectory:'/unused',existingProfile:'/unused'},'ABSOLUTE_PATH_REQUIRED_node'],
  ['../ce-chatgpt-wake/peer.mjs',[],{modules:'/unused',runDirectory:'relative',desktopConfig:'/unused',python:'/unused',bridge:'/unused'},'ABSOLUTE_PATH_REQUIRED_runDirectory'],
])test('configuration refuses '+expected,t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ce-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify(config));
  const result=spawnSync(process.execPath,[new URL(entry,import.meta.url).pathname,...args,file],{encoding:'utf8',cwd:root,env:{...process.env,HOME:root}});
  assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(expected));
});

test('wake endpoint mismatch is refused before loading runtime or sending',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ce-endpoint-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const desktop=path.join(root,'desktop.json');fs.writeFileSync(desktop,JSON.stringify({targetEndpoint:'chatgpt/selected',replyEndpoint:'pi/selected'}));
  fs.writeFileSync(path.join(root,'publication.json'),JSON.stringify({chatgptEndpoint:'chatgpt/different',endpointId:'pi/selected'}));
  const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify({runDirectory:root,modules:'/missing-runtime',desktopConfig:desktop,python:'/missing-python',bridge:'/missing-bridge'}));
  const result=spawnSync(process.execPath,[new URL('../ce-chatgpt-wake/peer.mjs',import.meta.url).pathname,file],{encoding:'utf8',cwd:root,env:{...process.env,HOME:root}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/DESKTOP_ENDPOINT_AUTHORIZATION_MISMATCH/);
  assert.equal(fs.readdirSync(root).some(f=>f.includes('send-attempt')),false);
});

test('wake prepare accepts common fields without Ovis placeholder tasks from another HOME and cwd',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ce-prepare-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const run=path.join(root,'new run'),modules=path.join(root,'runtime modules');
  const write=(name,value)=>{const f=path.join(modules,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,value);};
  write('@earendil-works/pi-coding-agent/package.json',JSON.stringify({version:'1.3.0',type:'module'}));
  write('@earendil-works/pi-coding-agent/dist/index.js',`export const SettingsManager={},DefaultResourceLoader={},createAgentSession={};export const SessionManager={create:()=>({appendMessage(){},getSessionId:()=> 'fresh-session',getSessionFile:()=> '/fixture/session'})};`);
  write('@zieglar/pi-chat-exchange/package.json',JSON.stringify({version:'0.3.0',type:'module'}));
  write('@zieglar/pi-chat-exchange/dist/tunnel/multi-session-policy.js',`export const readSelectedMultiSessionPolicy=()=>({config:{endpoint:{adapter:'chatgpt',endpointId:'chatgpt/alternate'}},manifest:{registrations:[{runtimeSessionId:'fresh-session'}]}});export const parseMultiSessionManifest=m=>m;`);
  write('@zieglar/pi-chat-exchange/dist/tunnel/background-manager.js',`export const parseTunnelProfile=s=>({tunnelId:'fixture',organizationId:'fixture',keyFile:'/fixture/credential-reference',mcpCommand:s.match(/command: "([^"]+)"/)[1],urlFile:s.match(/url_file: "([^"]+)"/)[1]});`);
  write('@zieglar/pi-chat-exchange/dist/tunnel/messaging-config.js',`import fs from 'node:fs';export const publishMessagingGeneration=(profile,binding,manifest)=>{fs.writeFileSync(profile+'.observed',JSON.stringify({binding,manifest}));return {durability:'synced',bindingPath:'/fixture/binding'};};`);
  write('@zieglar/pi-chat-exchange/dist/tunnel/profile.js',`export const buildTunnelMcpCommand=()=> 'fixture-node fixture-mcp --config fixture-binding';`);
  const original=path.join(root,'existing.yaml');fs.writeFileSync(original,'      command: "old-command"\n  url_file: "/old/health"\n');
  const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify({modules,runDirectory:run,existingProfile:original,node:process.execPath,endpointId:'pi/alternate',testId:'CE-WAKE-TEST-prepare'}));
  const result=spawnSync(process.execPath,[new URL('./ce-peer.mjs',import.meta.url).pathname,'prepare',file],{encoding:'utf8',cwd:os.tmpdir(),env:{...process.env,HOME:root}});
  assert.equal(result.status,0,result.stderr);
  const publication=JSON.parse(fs.readFileSync(path.join(run,'publication.json')));
  assert.equal(publication.endpointId,'pi/alternate');assert.equal(publication.chatgptEndpoint,'chatgpt/alternate');
  const observed=JSON.parse(fs.readFileSync(path.join(run,'tunnel.yaml.observed')));
  assert.equal(observed.binding.exchange.idempotencyKey,'CE-WAKE-TEST-prepare');
  assert.equal(observed.manifest.registrations[0].runtimeSessionId,'fresh-session');
  assert.equal(fs.readFileSync(original,'utf8'),'      command: "old-command"\n  url_file: "/old/health"\n');
});
