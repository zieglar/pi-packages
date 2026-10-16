/** E2-A current-only reclassification of legacy migration acceptance.
 * Historical success/lineage/fault tests are archived byte-for-byte in the
 * implementation evidence (LEGACY-BASELINE-INVENTORY.json), not counted PASS.
 * Current-open refusal, identity, tamper, hold, drift and zero-write invariants
 * are executable replacements below; migration.ts and its checksums are frozen.
 */
import { mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { migrateStore } from "../../src/storage/migration.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";
import { initializeStore,openStore } from "../../src/storage/store.js";
import { APPLICATION_ID,SQLITE_APPLICATION_ID,INITIAL_SCHEMA_SQL,INITIAL_MIGRATION_NAME,INITIAL_MIGRATION_CHECKSUM,
 V2_FOUNDATION_SQL,V2_FOUNDATION_NAME,V2_FOUNDATION_CHECKSUM,V3_FOUNDATION_SQL,V3_FOUNDATION_NAME,V3_FOUNDATION_CHECKSUM,
 V4_FOUNDATION_SQL,V4_FOUNDATION_NAME,V4_FOUNDATION_CHECKSUM,V5_FOUNDATION_SQL,V5_FOUNDATION_NAME,V5_FOUNDATION_CHECKSUM,
 V6_FOUNDATION_SQL,V6_FOUNDATION_NAME,V6_FOUNDATION_CHECKSUM } from "../../src/storage/schema.js";
import { createHostSecretFile,hostSecretPath } from "../../src/storage/trust-root.js";
const roots:string[]=[];const NOW="2026-10-09T00:00:00.000Z",UUID="018f5f43-52f8-7c5a-8f64-9d5e06d24a9a",SECRET=new Uint8Array(32).fill(0x33);
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function legacy(version:number){
 const root=mkdtempSync(join(realpathSync(tmpdir()),"ce-legacy-refuse-"));roots.push(root);
 const loc={directory:join(root,"db"),filename:"store.sqlite",databasePath:join(root,"db","store.sqlite")};const db=openStorageConnection(loc,undefined,true);
 const entry=[
  [INITIAL_SCHEMA_SQL,INITIAL_MIGRATION_NAME,INITIAL_MIGRATION_CHECKSUM],
  [V2_FOUNDATION_SQL,V2_FOUNDATION_NAME,V2_FOUNDATION_CHECKSUM],
  [V3_FOUNDATION_SQL,V3_FOUNDATION_NAME,V3_FOUNDATION_CHECKSUM],
  [V4_FOUNDATION_SQL,V4_FOUNDATION_NAME,V4_FOUNDATION_CHECKSUM],
  [V5_FOUNDATION_SQL,V5_FOUNDATION_NAME,V5_FOUNDATION_CHECKSUM],
  [V6_FOUNDATION_SQL,V6_FOUNDATION_NAME,V6_FOUNDATION_CHECKSUM],
 ][version-1]!;
 db.exec(entry[0]!);
 db.prepare("INSERT INTO store_metadata VALUES (1,?,?,?,?)").run(UUID,APPLICATION_ID,version,NOW);
 db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(version,entry[1]!,entry[2]!,NOW);
 db.exec("INSERT INTO restore_hold(singleton,held) VALUES (1,0)");
 if(version>=2){const digest=createHostSecretFile(join(loc.directory,loc.filename),()=>SECRET);db.prepare("INSERT INTO host_trust_root VALUES (1,?,?,1)").run(digest,NOW);}
 db.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${version}`);db.close();return loc;
}
function bytes(directory:string){return readdirSync(directory).sort().map(name=>[name,readFileSync(join(directory,name)).toString("hex")]);}
/** OUT-OF-MATRIX regression pin (no frozen stable test ID; not an E2-A matrix descriptor,
 * not a v6 Reader Compatibility or service-admission claim, not counted toward the 80
 * REQUIRED descriptors). It exists only to make the E2-A `recovery.ts` proof-open routing
 * change mutation-sensitive: under the superseded `preflight.kind === "v6"` condition an
 * explicit operator trust-root recovery on a genuine v6 Store committed generation N+1 and the
 * blanket capability revocation and then refused at the terminal current-only open, publishing
 * no handle. Normal open of that same Store must still refuse STORAGE_INCOMPATIBLE: this pin
 * asserts no commit-then-refuse, never historical admission. */
it("regression pin (out of matrix): v6 trust-root recovery proves no commit-then-refuse and stays refused on normal open",()=>{
 const loc=legacy(6);rmSync(hostSecretPath(loc.databasePath));
 const recovered=recoverTrustRoot({...loc,now:()=>NOW,secretBytes:()=>new Uint8Array(32).fill(0x44)});
 try {
  // The committed authority change is reported honestly for the historical shape it is.
  expect(recovered.schemaVersion).toBe(6);
  expect(recovered.database.prepare("PRAGMA user_version").get()).toEqual({user_version:6});
  expect(recovered.database.prepare("SELECT generation FROM host_trust_root ORDER BY generation").all()).toEqual([{generation:1},{generation:2}]);
 } finally { recovered.close(); }
 // Non-admission: the recovered v6 Store is still not serviceable through normal open.
 expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
});
for(const version of [1,2,3,4,5,6])it(`OLD-REFUSE-01/unsupported-v6-header: genuine v${version} foundation refuses current-only open unchanged`,()=>{
 const loc=legacy(version),before=bytes(loc.directory);
 expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
 expect(bytes(loc.directory)).toEqual(before);
 expect(()=>initializeStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_ALREADY_INITIALIZED"}));
 expect(bytes(loc.directory)).toEqual(before);
});
for(const [name,sql,code] of [
 ["tampered ledger","DROP TRIGGER schema_migrations_immutable; UPDATE schema_migrations SET checksum=replace(checksum,'a','b')","STORAGE_MIGRATION_CHECKSUM_MISMATCH"],
 ["schema drift","CREATE TABLE unauthorized(x TEXT) STRICT","STORAGE_INCOMPATIBLE"],
 ["version forgery","PRAGMA user_version=7","STORAGE_INCOMPATIBLE"],
 ["metadata forgery","DROP TRIGGER store_metadata_immutable; UPDATE store_metadata SET schema_version=5","STORAGE_INCOMPATIBLE"],
 ["foreign identity","PRAGMA application_id=123","STORAGE_FOREIGN_STORE"],
 ["too new","PRAGMA user_version=8","STORAGE_SCHEMA_TOO_NEW"],
] as const)it(`legacy refusal retains ${name} security and never repairs`,()=>{
 const loc=legacy(3),db=openStorageConnection(loc);db.exec(sql);db.close();const before=bytes(loc.directory);
 expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code}));expect(bytes(loc.directory)).toEqual(before);
});
it("retains migration-path refusal security without executing any historical step",()=>{
 const loc=legacy(1),before=bytes(loc.directory);
 for(const [fromVersion,toVersion] of [[2,2],[1,5],[3,3],[3,2],[4,4],[4,3],[3,5],[0,4],[1,7],[6,7]] as const){
  let began=0;
  expect(()=>migrateStore({...loc,fromVersion,toVersion,beforeTransaction:()=>{began++;throw new Error("forbidden historical step");}})).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
  expect(began).toBe(0);expect(bytes(loc.directory)).toEqual(before);
 }
});
