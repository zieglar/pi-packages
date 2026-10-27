#!/usr/bin/env node
/** Explicit operator-only caller for CE-TAKEOVER-RECOVERY-CALLER-001. */
import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
  CeRecoveryError,
  recoverExpiredOwnership,
} from "../dist/host/ownership-recovery.js";
import {
  MCP_BINDING_CONFIG_MAX_BYTES,
  McpBindingConfigError,
  parseMcpBindingConfig,
} from "../dist/host/mcp-binding-config.js";
import { openStore } from "../dist/storage/store.js";

const FLAGS = Object.freeze([
  "--config",
  "--confirm-endpoint",
  "--expect-owner-session",
  "--expect-fencing-token",
  "--expect-lease-started-at",
  "--expect-expires-at",
]);

function fail(code) {
  console.error(code);
  process.exitCode = 1;
}

function parseArguments(argv) {
  if (argv.length !== FLAGS.length * 2) throw new Error("invalid arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || values.has(flag) || typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new Error("invalid arguments");
    }
    values.set(flag, value);
  }
  if (values.size !== FLAGS.length) throw new Error("invalid arguments");
  return values;
}

function loadConfig(path) {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Error("invalid config path");
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MCP_BINDING_CONFIG_MAX_BYTES) throw new Error("invalid config file");
  return parseMcpBindingConfig(JSON.parse(bytes.toString("utf8")));
}

let store;
try {
  const args = parseArguments(process.argv.slice(2));
  const config = loadConfig(args.get("--config"));
  if (args.get("--confirm-endpoint") !== `${config.endpoint.adapter}/${config.endpoint.endpointId}`) {
    throw new Error("confirmation mismatch");
  }
  const tokenText = args.get("--expect-fencing-token");
  if (!/^[1-9][0-9]*$/.test(tokenText)) throw new Error("invalid fencing token");
  const fencingToken = Number(tokenText);
  if (!Number.isSafeInteger(fencingToken)) throw new Error("invalid fencing token");

  store = openStore({
    directory: config.store.directory,
    filename: config.store.file,
    busyTimeoutMs: 5_000,
  });
  const receipt = recoverExpiredOwnership(store, {
    adapter: config.endpoint.adapter,
    endpointId: config.endpoint.endpointId,
    expectedOwner: {
      sessionId: args.get("--expect-owner-session"),
      fencingToken,
      leaseStartedAt: args.get("--expect-lease-started-at") === "null" ? null : args.get("--expect-lease-started-at"),
      expiresAt: args.get("--expect-expires-at"),
    },
    leaseTtlSeconds: config.lease.ttlSeconds,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  if (error instanceof CeRecoveryError) fail(error.code);
  else if (error instanceof McpBindingConfigError) fail("CE_RECOVERY_CONFIG_INVALID");
  else fail("CE_RECOVERY_LAUNCH_INVALID");
} finally {
  try {
    store?.close();
  } catch {
    if (process.exitCode !== 1) fail("CE_RECOVERY_OUTCOME_UNKNOWN");
  }
}
