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
 * carry status codes and safe schema versions only — never configuration values, identifiers from
 * tool arguments, payloads, or capability secrets.
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startLiveAdoptionProbe } from "../tunnel/live-adoption-probe.js";
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
import { createLaunchSourceMetadataProbe } from "./source-metadata-probe-launch.js";
import { observeTransport } from "../control/mcp/debug-transport.js";
import { startLocalMcpHttp } from "../control/mcp/http-transport.js";
import { initializeStore, openStore } from "../storage/store.js";
import { StoreLifecycleError } from "../storage/errors.js";
import { createMcpPolicyAdmission } from "../tunnel/multi-session-admission.js";
import { CeHookRunner } from "../hooks/runner.js";
import { isDeepStrictEqual } from "node:util";
import { effectiveMcpHookRules, readLoadedMultiSessionPolicy, readSelectedMultiSessionPolicy } from "../tunnel/multi-session-policy.js";
import { createLiveMcpComposition, discoverLiveEndpoints, observeLiveMcpRuntime } from "../tunnel/live-mcp-composition.js";
import { createTaskOwnerComposition } from "./task-owner-composition.js";
import { mcpRuntimeSourceIdentity, writeMcpRuntimeMarker } from "../tunnel/mcp-runtime-marker.js";

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
function loadBindingConfig(path: string): { config: McpBindingConfig; launchDigest: string } {
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
    return { config: parseMcpBindingConfig(parsed), launchDigest: createHash("sha256").update(raw).digest("hex") };
  } catch (error) {
    if (error instanceof McpBindingConfigError) return fail(error.code, error.field);
    return fail("CE_MCP_CONFIG_INVALID", "config.unexpected");
  }
}

/** Open (or initialize on first use) the shared durable store. */
function openBindingStore(config: McpBindingConfig) {
  const options = { directory: config.store.directory, filename: config.store.file, busyTimeoutMs: 5_000 };
  debugEvent("store", "STORE_OPEN_STARTED");
  try {
    const store = existsSync(join(options.directory, options.filename)) ? openStore(options) : initializeStore(options);
    debugEvent("store", "STORE_OPEN_COMPLETED");
    return store;
  } catch (error) {
    if (error instanceof StoreLifecycleError && error.code === "STORAGE_SCHEMA_TOO_NEW") {
      const versions = error as StoreLifecycleError & { readonly observedSchemaVersion?: unknown; readonly supportedSchemaVersion?: unknown };
      const detail = (["observedSchemaVersion", "supportedSchemaVersion"] as const)
        .flatMap(key => typeof versions[key] === "number" && Number.isSafeInteger(versions[key]) && versions[key] >= 0
          ? [`${key}=${versions[key]}`] : []).join(" ");
      return fail("STORAGE_SCHEMA_TOO_NEW", detail || undefined);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    await runStdioServer();
    return;
  }
  const [flag, configPath, socketFlag, socketPath] = argv;
  if ((argv.length !== 2 && argv.length !== 4) || flag !== "--config" || configPath === undefined || !configPath.startsWith("/") ||
      (argv.length === 4 && (socketFlag !== "--http-socket" || socketPath === undefined || !socketPath.startsWith("/")))) {
    fail("CE_MCP_LAUNCH_INVALID", "usage: mcp-stdio.js --config /absolute/path.json [--http-socket /absolute/path.sock]");
  }
  const { config, launchDigest } = loadBindingConfig(configPath);
  // Verify actual launch bytes before Store creation; managed provenance grants nothing.
  const live = config.admissionPolicy?.kind === "ce-live-session-v1" || config.admissionPolicy?.kind === "ce-live-session-v2"
    ? createLiveMcpComposition(config, undefined, { bindingPath: configPath }) : undefined;
  const admission = live?.admission ?? createMcpPolicyAdmission(config, configPath);
  if (live === undefined) admission?.({ kind: "begin" });

  const loadedHookPolicy = config.admissionPolicy?.kind !== "ce-multi-session-v1" ? undefined : readLoadedMultiSessionPolicy(config.admissionPolicy.profilePath, configPath);
  const hookRunner = new CeHookRunner({
    directory: config.store.directory, rules: config.hooks ?? [],
    ...(loadedHookPolicy === undefined && live === undefined ? {} : { admit: (rule, event) => {
      if (event !== undefined && (!isDeepStrictEqual(event.sender, config.endpoint) || !isDeepStrictEqual(event.recipient, rule.recipient))) return false;
      if (live !== undefined) return live.hookAllowed(rule);
      return loadedHookPolicy !== undefined && effectiveMcpHookRules(loadedHookPolicy, readSelectedMultiSessionPolicy(loadedHookPolicy.profilePath)).some(candidate => isDeepStrictEqual(candidate, rule));
    } }),
  });
  const hookAudit = hookRunner.snapshot();
  console.error(`CE_HOOKS_ACTIVE active=${hookAudit.active} configured=${hookAudit.configured} rules=${hookAudit.rules.filter(rule => rule.enabled).map(rule => rule.id).join(",") || "none"}`);
  const store = openBindingStore(config);
  const host = new CeEndpointHost(store, {
    adapter: config.endpoint.adapter,
    allowlist: [{ endpointId: config.endpoint.endpointId }],
    recipients: config.recipients,
    ...(live === undefined ? {} : { liveRecipients: live.recipients }),
    exchangeNamespace: config.exchange.namespace,
    exchangeIdempotencyKey: config.exchange.idempotencyKey,
    leaseTtlSeconds: config.lease.ttlSeconds,
    payloadRead: { enabled: config.payloadRead.enabled },
    ack: { enabled: config.ack.enabled },
    onMessageCommitted: event => hookRunner.publish(event),
  });

  let bound: CeBoundEndpoint | undefined;
  let probe: Awaited<ReturnType<typeof startLiveAdoptionProbe>> | undefined;
  try {
  debugEvent("authority", "AUTHORITY_CHECK_STARTED", { stage: "requireUnowned" });
  const activeBound = CeBoundEndpoint.start(host, config.endpoint.endpointId, {
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
  bound = activeBound;

  let processStartedKey: string | undefined;
  try {
    const output = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000, maxBuffer: 4096, encoding: "utf8",
    });
    const match = /^\s*([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(output);
    if (match === null) throw new Error("process identity unavailable");
    processStartedKey = match[1]!;
    const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const source = mcpRuntimeSourceIdentity(packageRoot);
    writeMcpRuntimeMarker({ bindingPath: configPath, identity: { pid: process.pid, startedKey: processStartedKey }, source });
    debugEvent("server", "MCP_RUNTIME_IDENTIFIED", { version: source.packageVersion });
  } catch {
    console.error("CE_MCP_RUNTIME_UNVERIFIED");
  }

  debugEvent("authority", "OWNERSHIP_ACQUIRED", { owned: true });
  const taskOwner = createTaskOwnerComposition(configPath, config, live, host, activeBound);
  if (live !== undefined) {
    try {
      if (processStartedKey === undefined) throw new Error("process identity unavailable");
      probe = await startLiveAdoptionProbe({ ref: live.ref, launchDigest,
        identity: { pid: process.pid, startedKey: processStartedKey },
        observe: () => observeLiveMcpRuntime(live, host, activeBound, store, config.endpoint.endpointId),
      });
    } catch {
      // Local observation is advisory. Unsupported socket paths/identity cannot
      // attest readiness, but do not revoke an otherwise valid messaging port.
      console.error("CE_MCP_ADOPTION_UNVERIFIED");
    }
  }
  // HANDOFF-CE-E2B-01: advertise `ce_ack` only when the validated binding
  // declares the ack opt-in; the default surface stays exactly four tools.
  const createServer = () => createExchangeMcpServer(undefined, {
    port: activeBound, ackEnabled: config.ack.enabled, executionGuard: config.debugExecutionGuard,
    ...(taskOwner ?? {}),
    ...(live === undefined
      ? admission === undefined ? {} : { admission: () => admission({ kind: "inbox" }) }
      : { discovery: { discover: (previousEndpointId?: string, runtimeId?: string, useRuntimeBinding?: true, group?: string) =>
        discoverLiveEndpoints(live, activeBound, previousEndpointId, runtimeId, useRuntimeBinding, group) }, selectedTarget: live.selectedTarget, pairing: live.pairing }),
  }, socketPath === undefined ? createLaunchSourceMetadataProbe(configPath, launchDigest) : undefined);
  const server = socketPath === undefined ? createServer() : undefined;
  let http: Awaited<ReturnType<typeof startLocalMcpHttp>> | undefined;
  if (config.debugExecutionGuard.enabled) {
    debugEvent("server", "EXECUTION_GUARD_ARMED", { scope: "tools/call", stage: "unified-dispatch-entry" });
  }

  let initiated = false;
  const initiateShutdown = async (): Promise<void> => {
    if (initiated) return;
    initiated = true;
    await probe?.close();
    try {
      await http?.close();
      await server?.close();
    } catch {
      // Transport already gone; the lease release below is what matters.
    }
    const hookCleanup = hookRunner.close();
    const shutdown = await activeBound.shutdown();
    debugEvent("authority", "OWNERSHIP_RELEASED", { released: shutdown.released, detached: shutdown.detached });
    console.error(
      shutdown.released
        ? `CE_MCP_STOPPED released=true detached=${shutdown.detached}`
        : `CE_MCP_STOPPED released=false code=${shutdown.code ?? "CE_HOST_UNAVAILABLE"}`,
    );
    await hookCleanup;
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
  if (server !== undefined) {
    debugEvent("server", "TRANSPORT_CREATED");
    process.stdin.once("end", requestShutdown);
    process.stdin.once("close", requestShutdown);
    server.onclose = requestShutdown;
    await server.connect(observeTransport(new StdioServerTransport()));
  } else {
    http = await startLocalMcpHttp(socketPath!, createServer);
  }
  debugEvent("server", "TRANSPORT_CONNECTED");
  debugEvent("server", "SERVER_READY", { mode: "bound" });
  // HANDOFF-CE-E2B-01: the diagnostic mirrors exactly what the server above
  // advertises for this binding (same construction, same order) — ce_ack
  // appears only when the operator ack opt-in is enabled.
  const advertisedTools = [
    PING_TOOL_NAME,
    ...MESSAGING_TOOL_NAMES,
    ...(config.ack.enabled ? [CE_ACK_TOOL.name] : []),
    ...(live === undefined ? [] : ["ce_endpoints", "ce_pair"]),
    ...(taskOwner === undefined ? [] : ["ce_task_owner"]),
  ];
  console.error(`CE_MCP_STARTED tools=${advertisedTools.join(",")}`);
  await shutdownRequested;
  await initiateShutdown();
  } finally {
    try { await probe?.close(); }
    finally {
      const hooks = hookRunner.close();
      try { await bound?.shutdown(); }
      finally { await hooks; store.close(); }
    }
  }
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
