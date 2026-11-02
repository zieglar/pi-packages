import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDesktop,requireRunning} from './execution.mjs';

test('stop during awaited boundary prevents bridge spawn and next batch task', async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ovis-stop-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const window={root,end:Date.now()+5000,stopped:()=>false};
 await Promise.resolve();fs.writeFileSync(path.join(root,'stop-request'),'stop');
 assert.throws(()=>requireRunning(window),/WINDOW_STOPPED/);
 assert.throws(()=>runDesktop({python:'/must/not/spawn',bridge:'unused',task:{},env:{},window}),/WINDOW_STOPPED/);
});

test('active desktop wait monitors stop file and exits without result',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ovis-active-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const script=path.join(root,'sleep.py');fs.writeFileSync(script,'import time\ntime.sleep(20)\n');
 const window={root,end:Date.now()+5000,stopped:()=>false};
 const timer=setTimeout(()=>fs.writeFileSync(path.join(root,'stop-request'),'stop'),150);
 try {await assert.rejects(runDesktop({python:'python3',bridge:script,task:{desktopConfig:'unused',taskFile:'unused'},env:process.env,window}),/WINDOW_STOPPED/);}
 finally{clearTimeout(timer);}
});
