import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadTasks, authorizeTask} from './tasks.mjs';

test('two tasks retain independent result/attempt paths and exact payload authorization', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-tasks-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const tasks = [1,2].map(n => {
    const taskId = 'CE-OVIS-TEST-sequence-' + n;
    const text = JSON.stringify({taskId, text:'中文 turn ' + n});
    const taskFile = path.join(root,n+'.json');fs.writeFileSync(taskFile,text);
    return {taskId,taskFile,desktopConfig:path.join(root,n+'-desktop.json'),taskPayloadSha256:createHash('sha256').update(text).digest('hex')};
  });
  const loaded = loadTasks({runDirectory:root,tasks});
  assert.notEqual(loaded[0].recordRoot,loaded[1].recordRoot);
  assert.equal(authorizeTask(fs.readFileSync(tasks[0].taskFile,'utf8'),loaded),loaded[0]);
  assert.equal(authorizeTask(fs.readFileSync(tasks[1].taskFile,'utf8'),loaded),loaded[1]);
  assert.throws(() => authorizeTask(JSON.stringify({taskId:tasks[0].taskId,text:'changed'}),loaded),/UNAUTHORIZED_TASK_PAYLOAD/);
  assert.throws(() => loadTasks({runDirectory:root,tasks:[tasks[0],tasks[0]]}),/DUPLICATE_TASK_ID/);
  fs.writeFileSync(tasks[1].taskFile,'changed');
  assert.throws(() => authorizeTask(JSON.stringify({taskId:tasks[1].taskId,text:'中文 turn 2'}),loaded),/LOCAL_TASK_FILE_DRIFT/);
});

test('legacy one-task configuration preserves original evidence paths', () => {
  const tasks=loadTasks({runDirectory:'/private/operator-state',testId:'CE-OVIS-TEST-one',taskFile:'/task.json',desktopConfig:'/desktop.json',taskPayloadSha256:'a'.repeat(64)});
  assert.equal(tasks[0].recordRoot,'/private/operator-state');
});

test('real task IDs require explicit local execution mode', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ovis-task-mode-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const entry={taskId:'CE-OVIS-TASK-one',taskFile:path.join(root,'task.json'),desktopConfig:path.join(root,'desktop.json'),taskPayloadSha256:'a'.repeat(64)};
  assert.throws(()=>loadTasks({runDirectory:root,tasks:[entry]}),/INVALID_TASK_CONFIG/);
  assert.equal(loadTasks({runDirectory:root,taskMode:'execute',tasks:[entry]})[0].taskId,entry.taskId);
});
