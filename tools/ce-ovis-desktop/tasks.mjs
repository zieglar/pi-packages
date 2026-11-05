// Operator allowlist shared by the real peer and independent evidence verifier.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function loadTasks(config) {
  const entries = config.tasks ?? [{taskId:config.testId,taskFile:config.taskFile,desktopConfig:config.desktopConfig,taskPayloadSha256:config.taskPayloadSha256}];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) throw Error('BOUNDED_TASK_LIST_REQUIRED');
  const seen = new Set();
  return entries.map(entry => {
    const idPattern = config.taskMode === 'execute' ? /^CE-OVIS-(?:TEST|TASK)-[A-Za-z0-9-]{1,64}$/ : /^CE-OVIS-TEST-[A-Za-z0-9-]{1,64}$/;
    if (!idPattern.test(entry.taskId) || !/^[0-9a-f]{64}$/.test(entry.taskPayloadSha256) || typeof entry.taskFile !== 'string' || !path.isAbsolute(entry.taskFile) || typeof entry.desktopConfig !== 'string' || !path.isAbsolute(entry.desktopConfig)) throw Error('INVALID_TASK_CONFIG');
    if (seen.has(entry.taskId)) throw Error('DUPLICATE_TASK_ID');
    seen.add(entry.taskId);
    return {...entry,recordRoot:config.tasks ? path.join(config.runDirectory,'tasks',entry.taskId) : config.runDirectory};
  });
}

export function authorizeTask(text, tasks) {
  let task;
  try {task = JSON.parse(text);} catch {throw Error('INVALID_TEST_PAYLOAD');}
  const entry = tasks.find(t => t.taskId === task?.taskId);
  if (!entry || createHash('sha256').update(text).digest('hex') !== entry.taskPayloadSha256) throw Error('UNAUTHORIZED_TASK_PAYLOAD');
  if (fs.readFileSync(entry.taskFile,'utf8') !== text) throw Error('LOCAL_TASK_FILE_DRIFT');
  return entry;
}
