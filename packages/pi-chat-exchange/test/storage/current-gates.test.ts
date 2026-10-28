import { chmodSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openStore, initializeStore } from "../../src/storage/store.js";
import { hostSecretPath } from "../../src/storage/trust-root.js";
import { cleanupFixtures, fixture } from "./support/participant-fixture.js";
import { vi } from "vitest";
import { V6_FOUNDATION_NAME,V6_FOUNDATION_CHECKSUM } from "../../src/storage/schema.js";
afterEach(cleanupFixtures);
const cases: [string,string,(db:Pick<DatabaseSync, "exec">)=>void][]=[
 ["CUR-OPEN-02/missing-object","STORAGE_INCOMPATIBLE",db=>db.exec("DROP TRIGGER delivery_ack_receipt_nodelete")],
 ["CUR-OPEN-02/extra-object","STORAGE_INCOMPATIBLE",db=>db.exec("CREATE TABLE extra(x TEXT) STRICT")],
 ["CUR-OPEN-02/ledger-checksum","STORAGE_MIGRATION_CHECKSUM_MISMATCH",db=>db.exec("DROP TRIGGER schema_migrations_immutable; UPDATE schema_migrations SET checksum=replace(checksum,substr(checksum,1,1),'a')")],
 ["CUR-OPEN-02/version-metadata","STORAGE_INCOMPATIBLE",db=>db.exec("PRAGMA user_version=6")],
 ["CUR-OPEN-02/application-id","STORAGE_FOREIGN_STORE",db=>db.exec("PRAGMA application_id=1234")],
 ["CUR-OPEN-03/valid-held","STORAGE_RESTORE_HOLD",db=>db.exec("UPDATE restore_hold SET held=1,reason='test hold',detected_at='2026-10-10T00:00:00.000Z'")],
 ["CUR-OPEN-03/fk-failure","STORAGE_CORRUPT",db=>db.exec("PRAGMA foreign_keys=OFF; INSERT INTO delivery_cursor(exchange_id,participant_id,acked_audit_seq) VALUES ('absent','absent',0)")],
 ["OLD-REFUSE-01/unsupported-v6-header","STORAGE_INCOMPATIBLE",db=>db.exec("PRAGMA user_version=6")],
 ["OLD-REFUSE-01/unsupported-zero-header","STORAGE_INCOMPATIBLE",db=>db.exec("PRAGMA user_version=0")],
 ["OLD-READER-01/current-classifier-too-new","STORAGE_SCHEMA_TOO_NEW",db=>db.exec("PRAGMA user_version=8")],
];
for(const [id,code,mutate] of cases)it(`${id}: refuse unchanged without migration/reset/repair`,()=>{
 const f=fixture();mutate(f.store.database);f.store.close();
 const before=readFileSync(f.databasePath);
 expect(()=>openStore({directory:f.directory,filename:f.filename})).toThrowError(expect.objectContaining({code}));
 expect(readFileSync(f.databasePath)).toEqual(before);
 expect(()=>initializeStore({directory:f.directory,filename:f.filename})).toThrowError(expect.objectContaining({code:"STORAGE_ALREADY_INITIALIZED"}));
 expect(readFileSync(f.databasePath)).toEqual(before);
});
it.each(["insecure-artifact","secret-missing","secret-mismatch","integrity-failure"])("CUR-OPEN-03/%s: preserve distinct refusal",variant=>{
 const f=fixture();f.store.close();
 const secret=hostSecretPath(f.databasePath);
 const codes={"insecure-artifact":"STORAGE_FILESYSTEM_UNSAFE","secret-missing":"STORAGE_TRUST_ROOT_MISSING","secret-mismatch":"STORAGE_TRUST_ROOT_MISMATCH","integrity-failure":"STORAGE_CORRUPT"};
 if(variant==="insecure-artifact")chmodSync(f.databasePath,0o644);
 if(variant==="secret-missing")unlinkSync(secret);
 if(variant==="secret-mismatch")writeFileSync(secret,"a".repeat(64));
 if(variant==="integrity-failure")writeFileSync(f.databasePath,new Uint8Array([1,2,3]));
 const before=readFileSync(f.databasePath);
 expect(()=>openStore({directory:f.directory,filename:f.filename})).toThrowError(expect.objectContaining({code:codes[variant as keyof typeof codes]}));
 expect(readFileSync(f.databasePath)).toEqual(before);
});
it("OLD-REFUSE-01/unsupported-v6-header: normal open never executes historical reference rebuild SQL",()=>{
 const f=fixture(),db=f.store.database;
 db.exec("DROP TRIGGER store_metadata_immutable; DROP TRIGGER schema_migrations_immutable");
 db.exec("UPDATE store_metadata SET schema_version=6; PRAGMA user_version=6");
 db.prepare("UPDATE schema_migrations SET version=6,name=?,checksum=?").run(V6_FOUNDATION_NAME,V6_FOUNDATION_CHECKSUM);
 db.close();
 const original=DatabaseSync.prototype.exec,sql:string[]=[];
 const spy=vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this:DatabaseSync,text:string){sql.push(text);return original.call(this,text);});
 try{expect(()=>openStore({directory:f.directory,filename:f.filename})).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));}finally{spy.mockRestore();}
 expect(sql.some(s=>s.includes("participant_capability_v6"))).toBe(false);
});
