// Verification preload: never call an OS subprocess. Production release CLI runs
// unchanged; its npm boundary records routes only, including the publish attempt.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
const refuse = () => { throw new Error('release verification guard: forbidden execution or credential'); };
for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GH_TOKEN', 'GITHUB_TOKEN']) {
  if (process.env[key]) refuse();
}
const log = process.env.CE_NPM_STUB_LOG, routePath = process.env.CE_NPM_STUB_ROUTES;
if (!log || !routePath) refuse();
const routes = JSON.parse(readFileSync(routePath, 'utf8'));
childProcess.execFileSync = (binary, args, options = {}) => {
  if (binary !== 'npm' || !Array.isArray(args) || !['view', 'pack', 'publish'].includes(args[0])) refuse();
  appendFileSync(log, JSON.stringify({ argv: args, cwd: options.cwd ?? process.cwd(), substitute: true }) + '\n');
  const route = routes[args[0]];
  if (!route) refuse();
  if (route.status !== 0) {
    const error = new Error('release verification guard: npm substitute refusal');
    error.status = route.status; error.stdout = route.stdout ?? ''; error.stderr = route.stderr ?? '';
    throw error;
  }
  return route.stdout ?? '';
};
for (const name of ['exec', 'execSync', 'execFile', 'spawn', 'spawnSync', 'fork']) childProcess[name] = refuse;
syncBuiltinESMExports();
