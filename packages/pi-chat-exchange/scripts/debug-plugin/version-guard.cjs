'use strict';
// Independent debug derivative only. Preloaded in BOTH launcher and server.
// Never handle/suppress fatal errors; monitor retains Node's native exit.
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../server/.debug-logs');
function log(event, context = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, component: 'guard', event, ...context }) + '\n';
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('unsafe directory');
      const fd = fs.openSync(path.join(directory, `ce-debug-${process.pid}.jsonl`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      try { if (fs.fstatSync(fd).isFile()) fs.appendFileSync(fd, line); } finally { fs.closeSync(fd); }
    } catch { /* failure never changes guard decision */ }
    try { fs.writeSync(2, line); } catch { /* stderr gone */ }
  } catch { /* observation only */ }
}
log('VERSION_GUARD_STARTED');
log('NODE_RESOLVED', { stage: 'process.execPath' });
log('NODE_VERSION', { version: process.version });
process.on('exit', exitCode => log('PROCESS_EXIT', { exitCode }));
process.on('uncaughtExceptionMonitor', (_error, origin) => log(origin === 'unhandledRejection' ? 'UNHANDLED_REJECTION' : 'UNCAUGHT_EXCEPTION', { origin }));
if (process.version !== 'v24.21.0') {
  log('VERSION_GUARD_FAILED', { version: process.version });
  process.exit(78);
}
log('VERSION_GUARD_PASSED', { version: process.version });
