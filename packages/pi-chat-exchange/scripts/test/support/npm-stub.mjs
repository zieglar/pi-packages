// Test double for the npm CLI boundary.
//
// Production release code is executed for real; only the external `npm`
// process is replaced. It records every invocation and the presence of the
// long-lived token variable so tests can prove that no long-lived token is
// used and that no publish is retried.
//
//   CE_NPM_STUB_LOG     JSON-lines invocation log
//   CE_NPM_STUB_ROUTES  JSON route table
//
// Route keys are "pack", "view", and "publish". A route is
// { "status": number, "stdout": string, "stderr": string }.

import { appendFileSync, readFileSync } from "node:fs";

const logPath = process.env.CE_NPM_STUB_LOG;
const routePath = process.env.CE_NPM_STUB_ROUTES;
const routes = routePath ? JSON.parse(readFileSync(routePath, "utf8")) : {};
const args = process.argv.slice(2);

if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({
    argv: args,
    NPM_TOKEN: process.env.NPM_TOKEN ?? null,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    CE_RELEASE_ADMIN_TOKEN: process.env.CE_RELEASE_ADMIN_TOKEN ?? null,
    cwd: process.cwd(),
  })}\n`);
}

const key = args[0] ?? "";
const route = routes[key] ?? {
  pack: { status: 0, stdout: JSON.stringify([{ files: [] }]) },
  view: { status: 1, stdout: "", stderr: "npm error code E404\n" },
  publish: { status: 0, stdout: "" },
}[key] ?? { status: 1, stdout: "", stderr: `unsupported npm invocation: ${args.join(" ")}\n` };

if (route.stdout) process.stdout.write(route.stdout);
if (route.stderr) process.stderr.write(route.stderr);
process.exitCode = route.status ?? 0;
