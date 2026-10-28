// Test double for the GitHub CLI boundary.
//
// The release scripts under test are the real production modules. This stub
// replaces only the external `gh` process, so credential routing, argument
// construction, HTTP status mapping and refusal paths are exercised as
// implemented. It records every invocation, including the credentials the
// child process was given, so a test can prove that a privileged credential
// never reaches a write.
//
// Configuration comes from two environment variables:
//   CE_GH_STUB_LOG     path of the JSON-lines invocation log
//   CE_GH_STUB_ROUTES  path of a JSON route table
//
// Route keys are "<METHOD> <api path>" for `gh api`, "attestation <file>" for
// `gh attestation verify`, and "release create" / "release edit" for the
// release commands. A route is { "status": <number>, "body": <object> }.
// A route may also be { "exit": <number> } for a non-API command.

import { appendFileSync, readFileSync } from "node:fs";

const logPath = process.env.CE_GH_STUB_LOG;
const routePath = process.env.CE_GH_STUB_ROUTES;
const routes = routePath ? JSON.parse(readFileSync(routePath, "utf8")) : {};
const args = process.argv.slice(2);

if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({
    argv: args,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    CE_RELEASE_ADMIN_TOKEN: process.env.CE_RELEASE_ADMIN_TOKEN ?? null,
    cwd: process.cwd(),
  })}\n`);
}

function routeFor(key) {
  const entry = routes[key];
  if (!entry) {
    if (key.startsWith("attestation ")) return { exit: 0 };
    if (key === "release create" || key === "release edit") return { exit: 0 };
    return { status: 404, body: { message: "Not Found" } };
  }
  return entry;
}

function emitApi(status, body) {
  process.stdout.write(`HTTP/2.0 ${status} Status\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}\n`);
  process.exitCode = status === 200 ? 0 : 1;
}

if (args[0] === "api") {
  let method = "GET";
  const rest = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--method") { method = args[index + 1]; index += 1; continue; }
    if (args[index].startsWith("-")) {
      // A short flag may take its value as the next argument.
      if (args[index] === "-f" || args[index] === "-F" || args[index] === "--field") index += 1;
      continue;
    }
    rest.push(args[index]);
  }
  const path = rest[0] ?? "";
  const entry = routeFor(`${method} ${path}`);
  if (entry.exit !== undefined) process.exitCode = entry.exit;
  else emitApi(entry.status ?? 200, entry.body ?? {});
} else if (args[0] === "attestation") {
  const entry = routeFor(`attestation ${args[2] ?? ""}`);
  process.exitCode = entry.exit ?? 0;
  if (entry.stdout) process.stdout.write(entry.stdout);
} else if (args[0] === "release") {
  const entry = routeFor(`release ${args[1] ?? ""}`);
  process.exitCode = entry.exit ?? 0;
} else {
  process.stderr.write(`unsupported gh invocation: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
