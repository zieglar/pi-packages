// Test-only initialization crash boundaries; no secrets or exception text emitted.
import { writeSync } from 'node:fs';
const config=await new Promise(resolve=>process.once('message',resolve));
const emit=value=>writeSync(1,JSON.stringify(value)+'\n');
const stop=(db)=>{
 emit({event:'boundary',stage:config.stage,transaction:db.isTransaction});
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 throw new Error('unreachable');
};
const {resolveSqliteDriver}=await import(new URL('../../../src/storage/sqlite-driver-selection.ts',import.meta.url));
const selected=resolveSqliteDriver();
const driver={...selected,open(path,options){
 const db=selected.open(path,options),exec=db.exec.bind(db);
 db.exec=function(sql){
  if(config.stage==='before-begin'&&sql==='BEGIN IMMEDIATE')stop(this);
  if(config.stage==='before-commit'&&sql==='COMMIT'&&this.prepare('PRAGMA database_list').get()?.file)stop(this);
  exec(sql);
  if(config.stage==='after-commit'&&sql==='COMMIT'&&this.prepare('PRAGMA database_list').get()?.file)stop(this);
 };
 return db;
}};
try{
 const {initializeStore}=await import(config.storeUrl);
 const store=initializeStore({driver,directory:config.directory,filename:'store.sqlite',now:()=>config.now,secretBytes:()=>new Uint8Array(32).fill(90)});
 store.close();emit({event:'unexpected-return'});
}catch{emit({event:'unexpected-failure'});process.disconnect();}
