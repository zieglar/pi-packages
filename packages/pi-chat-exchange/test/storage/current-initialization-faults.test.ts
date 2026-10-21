import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeStore, openStore } from "../../src/storage/store.js";
import { NOW,SECRET } from "./support/participant-fixture.js";
import { StoreLifecycleError } from "../../src/storage/errors.js";
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function options(){const root=mkdtempSync(join(realpathSync(tmpdir()),"ce-init-v7-"));roots.push(root);return{directory:join(root,"db"),filename:"store.sqlite",now:()=>NOW,secretBytes:()=>SECRET};}
for(const stage of ["begin","commit"] as const)it(`CUR-INIT-01/fresh-current-foundation: ${stage} busy is stage-exact proven rollback`,()=>{
 const o=options(),exec=DatabaseSync.prototype.exec;let fired=0;
 vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,sql:string){
  if(sql===(stage==="begin"?"BEGIN IMMEDIATE":"COMMIT")){fired++;throw Object.assign(new Error("SYNTHETIC_PRIVATE_CAUSE"),{errcode:5});}
  return exec.call(this,sql);
 });
 expect(()=>initializeStore(o)).toThrowError(expect.objectContaining({stage,outcome:"ROLLED_BACK",retryable:true}));
 expect(fired).toBe(1);vi.restoreAllMocks();
 expect(()=>openStore(o)).toThrow();
 expect(()=>initializeStore(o)).toThrowError(expect.objectContaining({code:"STORAGE_ALREADY_INITIALIZED"}));
});
it("CUR-INIT-01/fresh-current-foundation: full commit then response lost is not falsely rolled back",()=>{
 const o=options(),exec=DatabaseSync.prototype.exec;let commits=0;
 vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,sql:string){
  exec.call(this,sql);if(sql==="COMMIT"){commits++;throw new Error("SYNTHETIC_PRIVATE_CAUSE");}
 });
 expect(()=>initializeStore(o)).toThrowError(expect.objectContaining({stage:"commit",outcome:"INDETERMINATE"}));
 expect(commits).toBe(1);vi.restoreAllMocks();
 const store=openStore(o);expect(store.schemaVersion).toBe(7);expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);store.close();
});
it("CUR-INIT-01/fresh-current-foundation: secret failure closes created handle without deleting artifacts",()=>{
 const o=options(),close=vi.spyOn(DatabaseSync.prototype,"close");
 expect(()=>initializeStore({...o,secretBytes:()=>{throw new Error("SYNTHETIC_PRIVATE_CAUSE");}})).toThrowError("store initialization failed");
 expect(close).toHaveBeenCalled();expect(existsSync(join(o.directory,o.filename))).toBe(true);
 expect(existsSync(join(o.directory,"host-secret"))).toBe(false);
 expect(()=>openStore(o)).toThrow();
 expect(()=>initializeStore(o)).toThrowError(expect.objectContaining({code:"STORAGE_ALREADY_INITIALIZED"}));
});
for(const phase of ["foundation","metadata","ledger","root","hold","pragma","precommit-manifest"] as const)it(`CUR-INIT-01/fresh-current-foundation: ${phase} failure leaves no admitted partial Store`,()=>{
 const o=options(),exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
 vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,sql:string){
  if(phase==="foundation" && sql.includes("CREATE TABLE delivery_ack_receipt"))throw new Error("SYNTHETIC_PRIVATE_CAUSE");
  if(phase==="pragma" && sql.includes("PRAGMA application_id="))throw new Error("SYNTHETIC_PRIVATE_CAUSE");
  exec.call(this,sql);
  if(phase==="precommit-manifest" && sql.includes("PRAGMA application_id="))exec.call(this,"CREATE TABLE unwanted(x TEXT) STRICT");
 });
 vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(this:DatabaseSync,sql:string){
  if((phase==="metadata"&&sql.startsWith("INSERT INTO store_metadata")) ||
     (phase==="ledger"&&sql.startsWith("INSERT INTO schema_migrations")) ||
     (phase==="root"&&sql.startsWith("INSERT INTO host_trust_root")) ||
     (phase==="hold"&&sql.startsWith("INSERT INTO restore_hold")))throw new Error("SYNTHETIC_PRIVATE_CAUSE");
  return prepare.call(this,sql);
 });
 expect(()=>initializeStore(o)).toThrow();vi.restoreAllMocks();
 const db=new DatabaseSync(join(o.directory,o.filename),{readOnly:true});
 expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);db.close();
 expect(()=>openStore(o)).toThrow();
 expect(()=>initializeStore(o)).toThrowError(expect.objectContaining({code:"STORAGE_ALREADY_INITIALIZED"}));
});
it("CUR-INIT-01/fresh-current-foundation: generator exceptions and malformed time never escape or publish",()=>{
 for(const variant of ["uuid-throws","clock-throws","clock-invalid","secret-domain-injection"]){
  const o=options();
  const fail=()=>{throw new Error("PRIVATE_GENERATOR_SENTINEL");};
  const extra=variant==="uuid-throws"?{storeUuid:fail}:variant==="clock-throws"?{now:fail}:variant==="clock-invalid"?{now:()=>"PRIVATE_GENERATOR_SENTINEL"}:{secretBytes:()=>{throw new StoreLifecycleError("STORAGE_CORRUPT","PRIVATE_GENERATOR_SENTINEL");}};
  let error:unknown;try{const leaked=initializeStore({...o,...extra});leaked.close();}catch(e){error=e;}
  expect(error).toBeDefined();expect(String(error)).not.toContain("PRIVATE_GENERATOR_SENTINEL");
  expect((error as Error).cause).toBeUndefined();expect(()=>openStore(o)).toThrow();
 }
});
it("CUR-INIT-01/fresh-current-foundation: postcommit validation I/O failure may leave complete durable evidence",()=>{
 const o=options(),exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;let committed=false;
 vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,sql:string){exec.call(this,sql);if(sql==="COMMIT")committed=true;});
 vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(this:DatabaseSync,sql:string){if(committed&&sql==="PRAGMA integrity_check")throw new Error("PRIVATE_GENERATOR_SENTINEL");return prepare.call(this,sql);});
 let error:unknown;try{initializeStore(o);}catch(e){error=e;}
 expect(committed).toBe(true);expect(error).toMatchObject({code:"STORAGE_CORRUPT"});expect(error).not.toHaveProperty("outcome","ROLLED_BACK");
 expect(String(error)).not.toContain("PRIVATE_GENERATOR_SENTINEL");vi.restoreAllMocks();
 const store=openStore(o);expect(store.schemaVersion).toBe(7);store.close();
});
