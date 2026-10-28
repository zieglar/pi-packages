import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AckWorld } from "./delivery-ack-fixture.js";
export interface WorkerEvent {event:string;result?:Record<string,unknown>;code?:string;stage?:string;outcome?:string;retryable?:boolean;transaction?:boolean;receipts?:number;audits?:number;samples?:number;clockValues?:string[];changes?:number}
export interface LaunchOptions {
 operation?:string;request?:object;now:string;boundary?:string;tag:string;busyTimeoutMs?:number;
 /** Start the worker's attempt from a file marker instead of IPC, so a peer whose event loop is blocked inside its own transaction can trigger it. */
 goByFile?:boolean;
 /** Atomically publish the first attempt's terminal event to a file the blocked peer can read synchronously. */
 outcomeFile?:boolean;
 /** After the first attempt, wait for a second IPC `go` and run the identical request again (emits `replay-result` / `replay-error`). */
 secondAttempt?:boolean;
 /** State-dependent clock: `before` until the test writes the gate marker, `after` once it exists. Overrides `now` for samples. */
 clockGate?:{before:string;after:string};
 /** Emit `begin-entered` immediately before this worker's BEGIN IMMEDIATE. */
 announceBegin?:boolean;
}
const idle=new Int32Array(new SharedArrayBuffer(4));
export async function launch(w:AckWorld,options:LaunchOptions){
 const releasePath=`${w.f.root}/${options.tag}.release`;
 const goPath=`${w.f.root}/${options.tag}.go`;
 const outcomePath=`${w.f.root}/${options.tag}.outcome`;
 const gatePath=`${w.f.root}/${options.tag}.clock-gate`;
 const child=spawn(process.execPath,["--import",fileURLToPath(new URL("./register-ts.mjs",import.meta.url)),fileURLToPath(new URL("./delivery-ack-worker.mjs",import.meta.url))],{stdio:["ignore","pipe","pipe","ipc"]});
 const events:WorkerEvent[]=[];let pending="",stderr="";
 const waiters:{event:string;resolve:(e:WorkerEvent)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
 child.stdout!.on("data",chunk=>{pending+=chunk;while(pending.includes("\n")){const end=pending.indexOf("\n"),e=JSON.parse(pending.slice(0,end)) as WorkerEvent;pending=pending.slice(end+1);events.push(e);for(const waiter of [...waiters])if(e.event===waiter.event){clearTimeout(waiter.timer);waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(e);}}});
 child.stderr!.on("data",chunk=>{stderr+=chunk;});
 const done=new Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string}>(resolve=>child.once("close",(code,signal)=>{
   resolve({code,signal,stderr});
   for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(new Error(`worker exited before boundary code=${code} signal=${signal} events=${JSON.stringify(events)}: ${stderr}`));}
 }));
 const wait=(event:string):Promise<WorkerEvent>=>{
  const existing=events.find(e=>e.event===event);if(existing)return Promise.resolve(existing);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("worker boundary timeout")),20000);waiters.push({event,resolve,reject,timer});});
 };
 child.send({storeUrl:new URL("../../../src/storage/store.ts",import.meta.url).href,
 ackUrl:new URL("../../../src/storage/delivery-ack.ts",import.meta.url).href,
 ownershipUrl:new URL("../../../src/storage/ownership.ts",import.meta.url).href,
 participantUrl:new URL("../../../src/storage/participant.ts",import.meta.url).href,
 directory:w.f.directory,filename:w.f.filename,request:options.request??w.input,operation:options.operation??"ack",now:options.now,boundary:options.boundary,releasePath,busyTimeoutMs:options.busyTimeoutMs,
 ...(options.goByFile?{goPath}:{}),...(options.outcomeFile?{outcomePath}:{}),...(options.secondAttempt?{secondAttempt:true}:{}),
 ...(options.clockGate?{clockGate:{path:gatePath,...options.clockGate}}:{}),...(options.announceBegin?{announceBegin:true}:{})});
 await wait("ready");
 /** Synchronous: usable from inside a caller's private ACK hook while that caller holds the writer lock.
  * Writes the go marker, then blocks until the worker atomically publishes its first-attempt outcome. */
 const attemptWhileHeld=():WorkerEvent=>{
  if(!options.goByFile||!options.outcomeFile)throw new Error("attemptWhileHeld requires goByFile and outcomeFile");
  writeFileSync(goPath,"go",{flag:"wx",mode:0o600});
  const deadline=Date.now()+20000;
  while(!existsSync(outcomePath)){if(Date.now()>deadline)throw new Error("worker outcome timeout");Atomics.wait(idle,0,0,5);}
  return JSON.parse(readFileSync(outcomePath,"utf8")) as WorkerEvent;
 };
 return{child,events,wait,done,go:()=>child.send({go:true}),release:()=>writeFileSync(releasePath,"release",{flag:"wx",mode:0o600}),
  openClockGate:()=>writeFileSync(gatePath,"open",{flag:"wx",mode:0o600}),attemptWhileHeld};
}
export async function terminate(child:ChildProcess,done:Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string}>){
 child.kill("SIGKILL");return done;
}
