// Loader-only: no AgentSession, runner binding, lifecycle dispatch, or discovery
// outside the caller's private empty cwd/HOME/agent directory.
import assert from "node:assert/strict";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const result = await discoverAndLoadExtensions([process.argv[2]], process.cwd(), process.env.PI_CODING_AGENT_DIR);
assert.deepEqual(result.errors, [], JSON.stringify(result.errors, null, 2));
assert.equal(result.extensions.length, 1);
const extension = result.extensions[0];
if (process.argv[3] === "host") {
  assert.ok(extension.commands.has("ce-status"));
  assert.ok(extension.commands.has("ce-tunnel"));
  assert.ok(extension.handlers.has("session_start"));
}
console.log(`Pi 1.3.0 loader-only ${process.argv[3]} PASS; Node ${process.version}`);
