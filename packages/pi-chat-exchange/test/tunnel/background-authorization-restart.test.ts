import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** Real independent processes and production Client/Node admission, with only
 * the OS account home redirected. The synthetic client is never executed. */
describe("persistent permission across independent plain processes", () => {
  it("restores and validates selected profile/client, then denies after revocation without Tunnel environment", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ce-auth-restart-")));
    try {
      // Hosted runner toolcache ancestors may be group-writable; admit a private copy of the same Node.
      const node = join(directory, "node"); copyFileSync(process.execPath, node); chmodSync(node, 0o700);
      const home = join(directory, "home"); mkdirSync(home, { mode: 0o700 });
      const profilePath = join(directory, "other-profile.yaml");
      // Explicit selection intentionally supports this delegated group-writable ancestor.
      const clientDirectory = join(directory, "client-install"); mkdirSync(clientDirectory, { mode: 0o770 });
      const clientPath = join(clientDirectory, "ce-synthetic-client"); writeFileSync(clientPath, "synthetic, never executed", { mode: 0o700 });
      const key = join(directory, "credential"); writeFileSync(key, "synthetic-only", { mode: 0o600 });
      const binding = join(directory, "binding.json");
      writeFileSync(binding, JSON.stringify({ version: 1, store: { directory, file: "store.sqlite" }, exchange: { namespace: "test", idempotencyKey: "test" },
        endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: [], lease: { ttlSeconds: 120, renewIntervalSeconds: 30 }, payloadRead: { enabled: false }, ack: { enabled: false } }), { mode: 0o600 });
      const bootstrap = join(directory, "account.mjs");
      writeFileSync(bootstrap, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';\nos.userInfo=()=>({uid:process.geteuid(),gid:process.getegid(),username:'synthetic',homedir:${JSON.stringify(home)},shell:'/bin/sh'}); syncBuiltinESMExports();\n`, { mode: 0o600 });
      const managerUrl = new URL("../../dist/tunnel/background-manager.js", import.meta.url).href;
      const profileUrl = new URL("../../dist/tunnel/profile.js", import.meta.url).href;
      const mcpPath = new URL("../../dist/bin/mcp-stdio.js", import.meta.url).pathname;
      const script = join(directory, "probe.mjs");
      writeFileSync(script, `import {writeFileSync} from 'node:fs'; import {createBackgroundTunnelManager,resolveTunnelProfilePath} from ${JSON.stringify(managerUrl)}; import {buildTunnelProfile,serializeTunnelProfile,buildTunnelMcpCommand} from ${JSON.stringify(profileUrl)};\nconst action=process.argv[2]; const profile=${JSON.stringify(profilePath)}; const client=${JSON.stringify(clientPath)};\nif(action==='grant'){writeFileSync(profile,serializeTunnelProfile(buildTunnelProfile({tunnelId:'tunnel_abcdef123456',keyFile:${JSON.stringify(key)},healthUrlFile:${JSON.stringify(join(directory, "health.url"))},mcpCommand:buildTunnelMcpCommand({nodePath:process.execPath,scriptPath:${JSON.stringify(mcpPath)},bindingPath:${JSON.stringify(binding)}})})),{mode:0o600}); const first=createBackgroundTunnelManager({env:{CE_TUNNEL_CLIENT_PATH:client},profilePath:profile}); first.grantAuthorization(first.authorizationScope().digest);}\nconst selected=resolveTunnelProfilePath({env:{}}); const manager=createBackgroundTunnelManager({env:{}}); if(action==='revoke')manager.revokeAuthorization(); console.log(JSON.stringify({selected,status:manager.authorizationStatus()}));\n`, { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CE_TUNNEL_") && key !== "NODE_OPTIONS"));
      const run = (action: string) => JSON.parse(execFileSync(node, ["--import", bootstrap, script, action], { env, encoding: "utf8", timeout: 20_000 }));
      expect(run("grant")).toEqual({ selected: profilePath, status: "granted" });
      expect(run("inspect")).toEqual({ selected: profilePath, status: "granted" });
      expect(run("revoke").status).toBe("revoked"); expect(run("inspect").status).toBe("revoked");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40_000);

  it("denies permission after only the installed MCP script content changes, before spawning", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ce-auth-script-drift-")));
    try {
      const node = join(directory, "node"); copyFileSync(process.execPath, node); chmodSync(node, 0o700);
      const installation = join(directory, "installation"); mkdirSync(installation, { mode: 0o700 });
      cpSync(new URL("../../dist", import.meta.url), join(installation, "dist"), { recursive: true });
      writeFileSync(join(installation, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
      symlinkSync(new URL("../../node_modules", import.meta.url), join(installation, "node_modules"), "dir");
      const home = join(directory, "home"); mkdirSync(home, { mode: 0o700 });
      const bootstrap = join(directory, "account.mjs");
      writeFileSync(bootstrap, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
os.userInfo=()=>({uid:process.geteuid(),gid:process.getegid(),username:'synthetic',homedir:${JSON.stringify(home)},shell:'/bin/sh'}); syncBuiltinESMExports();
`, { mode: 0o600 });
      const probe = join(directory, "probe.mjs");
      // Import the relocated production module so its import.meta.url owns script identity.
      // Only daemon spawn is synthetic; the client file must never be executed.
      writeFileSync(probe, `import assert from 'node:assert/strict';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createBackgroundTunnelManager} from ${JSON.stringify(pathToFileURL(join(installation, "dist/tunnel/background-manager.js")).href)};
import {buildTunnelProfile,serializeTunnelProfile,buildTunnelMcpCommand} from ${JSON.stringify(pathToFileURL(join(installation, "dist/tunnel/profile.js")).href)};
const directory=${JSON.stringify(directory)};
const profile=directory+'/tunnel.yaml', binding=directory+'/binding.json', client=directory+'/client', key=directory+'/credential';
const script=fileURLToPath(new URL('./installation/dist/bin/mcp-stdio.js',import.meta.url));
writeFileSync(client,'synthetic, never executed',{mode:0o700});
writeFileSync(key,'synthetic-only',{mode:0o600});
writeFileSync(binding,JSON.stringify({version:1,store:{directory,file:'store.sqlite'},exchange:{namespace:'test',idempotencyKey:'test'},endpoint:{adapter:'chatgpt',endpointId:'chatgpt/main'},recipients:[],lease:{ttlSeconds:120,renewIntervalSeconds:30},payloadRead:{enabled:false},ack:{enabled:false}}),{mode:0o600});
writeFileSync(profile,serializeTunnelProfile(buildTunnelProfile({tunnelId:'tunnel_abcdef123456',keyFile:key,healthUrlFile:directory+'/health.url',mcpCommand:buildTunnelMcpCommand({nodePath:process.execPath,scriptPath:script,bindingPath:binding})})),{mode:0o600});
let spawned=0;
const options={env:{CE_TUNNEL_BACKGROUND_ALLOW:'1'},profilePath:profile,clientPath:client,stateFilePath:directory+'/state.json',listProcesses:async()=>({kind:'ok',processes:[]}),spawn:()=>{spawned++;throw new Error('synthetic client must never execute');}};
const manager=createBackgroundTunnelManager(options);
const before=manager.authorizationScope(); manager.grantAuthorization(before.digest);
assert.equal(createBackgroundTunnelManager(options).authorizationStatus(),'granted');
const unchanged=[profile,binding,client].map(path=>readFileSync(path));
const originalScript=readFileSync(script);
appendFileSync(script,'\\n// isolated authorization regression drift\\n');
assert.notDeepEqual(readFileSync(script),originalScript);
const changed=createBackgroundTunnelManager(options);
assert.notEqual(changed.authorizationScope().digest,before.digest);
assert.equal(changed.authorizationScope().profileSha256,before.profileSha256);
assert.equal(changed.authorizationStatus(),'changed');
await assert.rejects(changed.start(),{code:'CE_TUNNEL_BACKGROUND_UNAUTHORIZED'});
assert.equal(spawned,0);
[profile,binding,client].forEach((path,index)=>assert.deepEqual(readFileSync(path),unchanged[index]));
console.log(JSON.stringify({before:'granted',after:changed.authorizationStatus(),denied:true,spawned,unchanged:true}));
`, { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CE_TUNNEL_") && key !== "NODE_OPTIONS"));
      const result = JSON.parse(execFileSync(node, ["--import", bootstrap, probe], { env, encoding: "utf8", timeout: 20_000 }));
      expect(result).toEqual({ before: "granted", after: "changed", denied: true, spawned: 0, unchanged: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40_000);
});
