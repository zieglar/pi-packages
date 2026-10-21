import { spawn } from "node:child_process";
import { mkdtempSync,realpathSync,rmSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach,expect,it } from "vitest";
import { initializeStore,openStore } from "../../src/storage/store.js";
import { NOW } from "./support/participant-fixture.js";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{force:true,recursive:true});});
for(const stage of ["before-begin","before-commit","after-commit"])it(`CUR-INIT-01/fresh-current-foundation: real crash ${stage}, known exit and independent full validation`,async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),"ce-init-crash-"));roots.push(root);const directory=join(root,"db");
 const child=spawn(process.execPath,["--import",fileURLToPath(new URL("./support/register-ts.mjs",import.meta.url)),fileURLToPath(new URL("./support/current-init-crash-worker.mjs",import.meta.url))],{stdio:["ignore","pipe","pipe","ipc"]});
 let stdout="",stderr="";
 const done=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
 const boundary=new Promise<Record<string,unknown>>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error("initialization boundary timeout")),15000);
  child.stdout!.on("data",chunk=>{stdout+=chunk;if(stdout.includes("\n")){clearTimeout(timer);resolve(JSON.parse(stdout.slice(0,stdout.indexOf("\n"))));}});
  child.once("error",reject);
 });
 child.stderr!.on("data",chunk=>{stderr+=chunk;});
 child.send({stage,directory,now:NOW,storeUrl:new URL("../../src/storage/store.ts",import.meta.url).href});
 try{
  expect(await boundary).toEqual({event:"boundary",stage,transaction:stage==="before-commit"});
  expect(child.kill("SIGKILL")).toBe(true);expect(await done).toEqual({code:null,signal:"SIGKILL"});expect(stderr).toBe("");
  expect(existsSync(join(directory,"host-secret"))).toBe(true);
  const options={directory,filename:"store.sqlite"};
  if(stage==="after-commit"){const store=openStore(options);expect(store.schemaVersion).toBe(7);expect(store.database.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);store.close();}
  else expect(()=>openStore(options)).toThrow();
  expect(()=>initializeStore(options)).toThrowError(expect.objectContaining({code:"STORAGE_ALREADY_INITIALIZED"}));
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await done;}}
},30000);
