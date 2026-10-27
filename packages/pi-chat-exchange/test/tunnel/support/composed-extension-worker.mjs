// No Pi installation/state is launched: actual extension factory + trusted synthetic ctx.
// Heartbeat callbacks are the actual production callbacks, advanced only by explicit IPC.
const intervals = new Map();
let timerId = 0;
globalThis.setInterval = (callback, delay) => {
  const timer = { id: ++timerId, unref() {} };
  intervals.set(timer, { callback, delay });
  return timer;
};
globalThis.clearInterval = timer => intervals.delete(timer);
const entries = [];
const notices = [];
let confirmations = 0;
const ctx = { mode: 'tui', hasUI: true, cwd: process.env.PI_CODING_AGENT_DIR,
  sessionManager: { getSessionId: () => process.argv[2], getSessionFile: () => undefined, getBranch: () => entries },
  ui: { notify: text => notices.push(text), confirm: async () => { confirmations++; return true; }, custom: async () => { throw Error('NO REAL TUI'); } } };
let events, tools, commands, replacement = 0;
async function load() {
  events = new Map(); tools = new Map(); commands = new Map();
  const { default: factory } = await import(new URL(`../../../pi-extension/index.ts?replacement=${replacement++}`, import.meta.url));
  factory({ on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
}
await load();
let chain = Promise.resolve();
process.on('message', message => {
  chain = chain.then(async () => {
    const { id, operation, name, input, reason } = message;
    try {
      let result;
      const noticeStart = notices.length;
      if (operation === 'start') result = await events.get('session_start')({ reason: reason ?? 'startup' }, ctx);
      else if (operation === 'stop') result = await events.get('session_shutdown')({ reason: reason ?? 'quit' }, ctx);
      else if (operation === 'replace') { await load(); result = await events.get('session_start')({ reason: 'reload' }, ctx); }
      else if (operation === 'tool') result = await tools.get(name).execute('synthetic-ipc', input ?? {}, undefined, undefined, ctx);
      else if (operation === 'command') result = await commands.get(name ?? 'ce-tunnel').handler(input ?? '', ctx);
      else if (operation === 'heartbeat') { const count = intervals.size; for (const { callback } of [...intervals.values()]) await callback(); result = { callbacks: count, remaining: intervals.size }; }
      else if (operation === 'inspect') result = { entries, confirmations, timers: intervals.size, pid: process.pid, node: process.version };
      else if (operation === 'exit') { await events.get('session_shutdown')({ reason: 'quit' }, ctx); process.send({ id, result: { exited: true } }, () => process.disconnect()); return; }
      else throw Error('Unknown synthetic IPC operation');
      process.send({ id, result: result ?? null, notices: notices.slice(noticeStart) });
    } catch (error) { process.send({ id, error: String(error.stack ?? error) }); }
  });
});
process.send({ ready: true, pid: process.pid, node: process.version });
