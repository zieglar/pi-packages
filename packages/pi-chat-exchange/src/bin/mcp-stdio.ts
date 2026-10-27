#!/usr/bin/env node
/**
 * stdio entrypoint for the pi-chat-exchange MCP server (composition only).
 *
 * Intended launch forms:
 *   node dist/bin/mcp-stdio.js
 *     Phase 1 smoke surface: exactly the `ping` tool, no durable state.
 *
 *   node dist/bin/mcp-stdio.js --config /abs/path/binding.json
 *     CE-0002 B3-P3B messaging surface: binds ONE Endpoint from trusted,
 *     operator-controlled launch configuration (never from tool arguments,
 *     never from the environment), acquires its ownership lease with
 *     `requireUnowned`, renews it on a heartbeat, and releases it on clean
 *     shutdown. A prior crashed instance leaves an ownership row that refuses
 *     startup — fail closed, no takeover.
 *
 *   tunnel-client run --profile pi-chat-exchange   (with --mcp-command "node .../mcp-stdio.js")
 *
 * stdout is reserved for MCP protocol frames; diagnostics go to stderr and
 * carry status codes only — never configuration values, identifiers from
 * tool arguments, payloads, or capability secrets.
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runStdioServer, createExchangeMcpServer } from "../control/mcp/server.js";
import { CE_ACK_TOOL, MESSAGING_TOOL_NAMES } from "../control/mcp/messaging-tools.js";
import { PING_TOOL_NAME } from "../control/mcp/ping.js";
import { CeEndpointHost } from "../host/endpoint-host.js";
import { CeBoundEndpoint } from "../host/bound-endpoint.js";
import {
  McpBindingConfigError,
  MCP_BINDING_CONFIG_MAX_BYTES,
  parseMcpBindingConfig,
  type McpBindingConfig,
} from "../host/mcp-binding-config.js";
import { debugEvent, errorSummary } from "../control/debug-log.js";
import { observeTransport } from "../control/mcp/debug-transport.js";
import { initializeStore, openStore } from "../storage/store.js";
import { createMcpPolicyAdmission } from "../tunnel/multi-session-admission.js";

debugEvent("server", "SERVER_ENTRY", { version: process.version });
// Monitor rather than handle exceptions: preserve Node's fatal exit behavior.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  debugEvent("process", origin === "unhandledRejection" ? "UNHANDLED_REJECTION" : "UNCAUGHT_EXCEPTION", { ...errorSummary(error), origin });
});
process.on("exit", (exitCode) => debugEvent("process", "PROCESS_EXIT", { exitCode }));

function fail(code: string, detail?: string): never {
  debugEvent("server", "MCP_ERROR", { code, stage: "startup" });
  console.error(detail === undefined ? code : `${code} ${detail}`);
  process.exit(1);
}

/** Read the binding configuration from an absolute path, refusing anything
 * oversized or unreadable before a single durable write can happen. */
function loadBindingConfig(path: string): McpBindingConfig {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return fail("CE_MCP_CONFIG_INVALID", "config.unreadable");
  }
  if (size > MCP_BINDING_CONFIG_MAX_BYTES) return fail("CE_MCP_CONFIG_INVALID", "config.too_large");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return fail("CE_MCP_CONFIG_INVALID", "config.unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("CE_MCP_CONFIG_INVALID", "config.not_json");
  }
  try {
    return parseMcpBindingConfig(parsed);
  } catch (error) {
    if (error instanceof McpBindingConfigError) return fail(error.code, error.field);
    return fail("CE_MCP_CONFIG_INVALID", "config.unexpected");
  }
}

/** Open (or initialize on first use) the shared durable store. */
function openBindingStore(config: McpBindingConfig) {
  const options = { directory: config.store.directory, filename: config.store.file, busyTimeoutMs: 5_000 };
  debugEvent("store", "STORE_OPEN_STARTED");
  const store = existsSync(join(options.directory, options.filename)) ? openStore(options) : initializeStore(options);
  debugEvent("store", "STORE_OPEN_COMPLETED");
  return store;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await runStdioServer();
    return;
  }
  const [flag, configPath] = argv;
  if (argv.length !== 2 || flag !== "--config" || configPath === undefined || !configPath.startsWith("/")) {
    fail("CE_MCP_LAUNCH_INVALID", "usage: mcp-stdio.js [--config /absolute/path.json]");
  }
  const config = loadBindingConfig(configPath);
  // Verify actual launch bytes before Store creation; managed provenance grants nothing.
  const admission = createMcpPolicyAdmission(config, configPath);
  admission?.({ kind: "begin" });

  const host = new CeEndpointHost(openBindingStore(config), {
    adapter: config.endpoint.adapter,
    allowlist: [{ endpointId: config.endpoint.endpointId }],
    recipients: config.recipients,
    exchangeNamespace: config.exchange.namespace,
    exchangeIdempotencyKey: config.exchange.idempotencyKey,
    leaseTtlSeconds: config.lease.ttlSeconds,
    payloadRead: { enabled: config.payloadRead.enabled },
    ack: { enabled: config.ack.enabled },
  });

  debugEvent("authority", "AUTHORITY_CHECK_STARTED", { stage: "requireUnowned" });
  const bound = CeBoundEndpoint.start(host, config.endpoint.endpointId, {
    renewIntervalMs: config.lease.renewIntervalSeconds * 1_000,
    ...(admission === undefined ? {} : { admission }),
    onEvent: (event) => {
      debugEvent("authority", "AUTHORITY_CHECK_RESULT", { stage: event.kind });
      if (event.kind === "renewed") return;
      // Codes only; renewal_deferred is retryable at the next tick,
      // renewal_stopped has already blocked new sends.
      console.error(
        event.kind === "renewal_deferred"
          ? `CE_MCP_RENEWAL_DEFERRED code=${event.code}`
          : `CE_MCP_RENEWAL_STOPPED code=${event.code}`,
      );
    },
  });

  debugEvent("authority", "OWNERSHIP_ACQUIRED", { owned: true });
  // HANDOFF-CE-E2B-01: advertise `ce_ack` only when the validated binding
  // declares the ack opt-in; the default surface stays exactly four tools.
  const server = createExchangeMcpServer(undefined, {
    port: bound, ackEnabled: config.ack.enabled, executionGuard: config.debugExecutionGuard,
    ...(admission === undefined ? {} : { admission: () => admission({ kind: "inbox" }) }),
  });
  if (config.debugExecutionGuard.enabled) {
    debugEvent("server", "EXECUTION_GUARD_ARMED", { scope: "tools/call", stage: "unified-dispatch-entry" });
  }
  const transport = observeTransport(new StdioServerTransport());
  debugEvent("server", "TRANSPORT_CREATED");

  let initiated = false;
  const initiateShutdown = async (): Promise<void> => {
    if (initiated) return;
    initiated = true;
    try {
      await server.close();
    } catch {
      // Transport already gone; the lease release below is what matters.
    }
    const shutdown = await bound.shutdown();
    debugEvent("authority", "OWNERSHIP_RELEASED", { released: shutdown.released, detached: shutdown.detached });
    console.error(
      shutdown.released
        ? `CE_MCP_STOPPED released=true detached=${shutdown.detached}`
        : `CE_MCP_STOPPED released=false code=${shutdown.code ?? "CE_HOST_UNAVAILABLE"}`,
    );
  };

  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolvePromise) => {
    resolveShutdown = resolvePromise;
  });
  const requestShutdown = (): void => resolveShutdown();

  // `on`, not `once`: a repeat SIGTERM/SIGINT during the drain window must be
  // absorbed by this idempotent request instead of hitting Node's default
  // disposition and killing the process before the lease is released.
  process.on("SIGTERM", () => { debugEvent("process", "PROCESS_SIGNAL", { signal: "SIGTERM" }); requestShutdown(); });
  process.on("SIGINT", () => { debugEvent("process", "PROCESS_SIGNAL", { signal: "SIGINT" }); requestShutdown(); });
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  server.onclose = requestShutdown;

  await server.connect(transport);
  debugEvent("server", "TRANSPORT_CONNECTED");
  debugEvent("server", "SERVER_READY", { mode: "bound" });
  // HANDOFF-CE-E2B-01: the diagnostic mirrors exactly what the server above
  // advertises for this binding (same construction, same order) — ce_ack
  // appears only when the operator ack opt-in is enabled.
  const advertisedTools = [
    PING_TOOL_NAME,
    ...MESSAGING_TOOL_NAMES,
    ...(config.ack.enabled ? [CE_ACK_TOOL.name] : []),
  ];
  console.error(`CE_MCP_STARTED tools=${advertisedTools.join(",")}`);
  await shutdownRequested;
  await initiateShutdown();
}

main().catch((error: unknown) => {
  debugEvent("server", "MCP_ERROR", { stage: "startup", ...errorSummary(error) });
  // Sanitized: host refusals carry fixed codes; anything else collapses
  // without echoing message text (which could contain operator paths).
  const code = typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: unknown }).code)
    : "CE_MCP_START_FAILED";
  console.error(code.startsWith("CE_") ? code : "CE_MCP_START_FAILED");
  process.exitCode = 1;
});
