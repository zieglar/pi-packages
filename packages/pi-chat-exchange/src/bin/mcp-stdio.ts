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
import { CeEndpointHost } from "../host/endpoint-host.js";
import { CeBoundEndpoint } from "../host/bound-endpoint.js";
import {
  McpBindingConfigError,
  MCP_BINDING_CONFIG_MAX_BYTES,
  parseMcpBindingConfig,
  type McpBindingConfig,
} from "../host/mcp-binding-config.js";
import { initializeStore, openStore } from "../storage/store.js";

function fail(code: string, detail?: string): never {
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
  return existsSync(join(options.directory, options.filename)) ? openStore(options) : initializeStore(options);
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

  const host = new CeEndpointHost(openBindingStore(config), {
    adapter: config.endpoint.adapter,
    allowlist: [{ endpointId: config.endpoint.endpointId }],
    recipients: config.recipients,
    exchangeNamespace: config.exchange.namespace,
    exchangeIdempotencyKey: config.exchange.idempotencyKey,
    leaseTtlSeconds: config.lease.ttlSeconds,
    payloadRead: { enabled: config.payloadRead.enabled },
  });

  const bound = CeBoundEndpoint.start(host, config.endpoint.endpointId, {
    renewIntervalMs: config.lease.renewIntervalSeconds * 1_000,
    onEvent: (event) => {
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

  const server = createExchangeMcpServer(undefined, { port: bound });
  const transport = new StdioServerTransport();

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
  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  server.onclose = requestShutdown;

  await server.connect(transport);
  console.error(`CE_MCP_STARTED tools=ping,ce_send,ce_inbox_list,ce_read_payload`);
  await shutdownRequested;
  await initiateShutdown();
}

main().catch((error: unknown) => {
  // Sanitized: host refusals carry fixed codes; anything else collapses
  // without echoing message text (which could contain operator paths).
  const code = typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: unknown }).code)
    : "CE_MCP_START_FAILED";
  console.error(code.startsWith("CE_") ? code : "CE_MCP_START_FAILED");
  process.exitCode = 1;
});
