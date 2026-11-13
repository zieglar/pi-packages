#!/usr/bin/env node
/** Explicit local operator command. No Store, sender, credentials or remote mutation. */
import { parseArgs, isDeepStrictEqual } from "node:util";
import { readPrivateMessagingFile } from "../tunnel/messaging-config.js";
import { parseMcpBindingConfig } from "../host/mcp-binding-config.js";
import { createEndpointRuntimeBinding } from "../tunnel/endpoint-runtime-binding.js";

try {
  const {values} = parseArgs({options: {config: {type: "string"}, action: {type: "string"}, "runtime-id": {type: "string"},
    "expected-revision": {type: "string"}, "accept-endpoint-scope": {type: "boolean"}}});
  const action = values.action, path = values.config;
  if (path === undefined || !["show", "set", "revoke"].includes(action ?? "")) throw new Error("CE_RUNTIME_BINDING_INVALID");
  if (action === "show" && !isDeepStrictEqual(Object.keys(values).sort(), ["action", "config"]) ||
    action === "revoke" && values["runtime-id"] !== undefined || action === "set" && values["runtime-id"] === undefined) throw new Error("CE_RUNTIME_BINDING_INVALID");
  const file = readPrivateMessagingFile(path);
  if (file === undefined) throw new Error("CE_RUNTIME_BINDING_INVALID");
  const config = parseMcpBindingConfig(JSON.parse(file.bytes.toString("utf8")));
  const binding = createEndpointRuntimeBinding(path, config);
  const selection = action === "show" ? binding.read() : binding.update({runtimeId: action === "revoke" ? null : values["runtime-id"],
    expectedRevision: values["expected-revision"], acceptEndpointScope: values["accept-endpoint-scope"]});
  console.log(JSON.stringify({scopeNotice: "CE Endpoint selection shared by all callers of this launch; no ChatGPT conversation identity is attested; no permissions granted",
    callerEndpoint: config.endpoint, selection}));
  if (selection.status === "unavailable") process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.error(JSON.stringify({error: /^CE_RUNTIME_BINDING_(INVALID|CONFLICT|RUNTIME_UNAVAILABLE|WRITE_UNCERTAIN)$/.test(message) ? message : "CE_RUNTIME_BINDING_INVALID"}));
  process.exitCode = 1;
}
