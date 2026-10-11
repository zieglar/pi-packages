/**
 * CE-0002 B3-P3B — minimal Pi runtime extension for local authorized
 * chat-exchange messaging.
 *
 * Verified against @earendil-works/pi-coding-agent 0.86.1 (installed). The
 * minimal structural types below mirror the installed declarations
 * (dist/core/extensions/types.d.ts): ExtensionAPI.on/registerTool/
 * registerCommand/appendEntry, ExtensionContext.sessionManager/
 * ui/hasUI/mode, SessionStartEvent.reason, AgentToolResult.content. They are
 * deliberately re-declared so this file has no SDK dependency beyond the
 * runtime-loading pi process itself.
 *
 * Security model (see README.md):
 * - The operator allowlist is the only registration authority. Model/tool
 *   arguments can never register Participants, issue capabilities, or change
 *   ownership; they select recipient labels and supply message text only.
 * - Capability plaintext never appears here: the host adapter keeps tokens in
 *   process memory; this file only ever receives identifiers and results.
 * - The persisted mapping (pi.appendEntry) carries identifiers only.
 * - No background polling, no ACK, no inbox discovery, no cross-process
 *   signalling. SQLite inserts never become conversation-visible by
 *   themselves; ce_read metadata is operator/model-consumed explicitly.
 *
 * Prerequisite: the package must be built once (pnpm --dir packages/
 * pi-chat-exchange build) because this extension imports the compiled host
 * seam from packages/pi-chat-exchange/dist.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CeHostRefusal,
  CeSessionHost,
  type CeHostPolicy,
  type CeMappingIdentifiers,
} from "../../../packages/pi-chat-exchange/dist/endpoints/pi/session-host.js";
import { PI_ADAPTER_KIND } from "../../../packages/pi-chat-exchange/dist/endpoints/pi/contract.js";
import { initializeStore, openStore } from "../../../packages/pi-chat-exchange/dist/storage/store.js";

// ---------------------------------------------------------------------------
// Minimal structural types (verified against Pi 0.86.1 declarations).
// ---------------------------------------------------------------------------

interface SessionManagerView {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getBranch(): ReadonlyArray<Record<string, unknown>>;
}

interface UiView {
  notify(message: string, level: "info" | "warning" | "error"): void;
}

interface ExtensionContextView {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly sessionManager: SessionManagerView;
  readonly ui: UiView;
}

interface ToolResultView {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface ToolDefinitionView {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /** JSON-Schema object; TypeBox schemas are JSON Schema at runtime. */
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContextView,
  ): Promise<ToolResultView>;
}

interface ExtensionApiView {
  on(event: "session_start", handler: (event: { reason: string }, ctx: ExtensionContextView) => Promise<void> | void): void;
  on(event: "session_shutdown", handler: (event: { reason: string }, ctx: ExtensionContextView) => Promise<void> | void): void;
  registerTool(tool: ToolDefinitionView): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: ExtensionContextView) => Promise<void> | void },
  ): void;
  appendEntry(customType: string, data?: unknown): void;
}

// ---------------------------------------------------------------------------
// Operator configuration.
// ---------------------------------------------------------------------------

interface AllowlistFile {
  readonly exchangeNamespace?: string;
  readonly exchangeIdempotencyKey?: string;
  readonly leaseTtlSeconds?: number;
  readonly sessions?: Record<string, { readonly endpointId?: string }>;
}

const EXTENSION_DIR = join(fileURLToPath(import.meta.url), "..");

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function loadAllowlist(): AllowlistFile {
  const path = envOr("CE_ALLOWLIST", join(EXTENSION_DIR, "allowlist.json"));
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AllowlistFile;
  } catch {
    return {};
  }
}

function endpointForPiSession(allowlist: AllowlistFile, piSessionId: string): string | undefined {
  const entry = allowlist.sessions?.[piSessionId];
  return typeof entry?.endpointId === "string" && entry.endpointId.length > 0 ? entry.endpointId : undefined;
}

function openHostStore() {
  const directory = envOr("CE_STORE_DIR", join(EXTENSION_DIR, "store"));
  const filename = envOr("CE_STORE_FILE", "ce-store.sqlite");
  const options = { directory, filename, busyTimeoutMs: 5_000 };
  return existsSync(join(directory, filename)) ? openStore(options) : initializeStore(options);
}

// ---------------------------------------------------------------------------
// Extension factory.
// ---------------------------------------------------------------------------

export default function ceChatExchange(pi: ExtensionApiView): void {
  const allowlist = loadAllowlist();
  let host: CeSessionHost | undefined;
  let currentEndpoint: string | undefined;
  /** Truthful startup failure (e.g. authority absent after lease expiry).
   * Tools report this instead of a misleading not-registered refusal. */
  let startupFailure: CeHostRefusal | undefined;
  const notify = (ctx: ExtensionContextView, message: string, level: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(message, level);
      } catch {
        /* notification is best effort in every mode */
      }
    }
  };

  const getHost = (): CeSessionHost => {
    if (host === undefined) {
      const store = openHostStore();
      const sessions = Object.entries(allowlist.sessions ?? {}).map(([piSessionId, entry]) => ({
        piSessionId,
        endpointId: typeof entry.endpointId === "string" ? entry.endpointId : "",
      }));
      const envTtl = process.env.CE_LEASE_TTL_SECONDS;
      const policy: CeHostPolicy = {
        adapter: PI_ADAPTER_KIND,
        exchangeNamespace: allowlist.exchangeNamespace ?? "pi-local",
        exchangeIdempotencyKey: allowlist.exchangeIdempotencyKey ?? "pi-local-exchange",
        allowlist: sessions,
        ...(envTtl !== undefined && envTtl !== ""
          ? { leaseTtlSeconds: Number(envTtl) }
          : allowlist.leaseTtlSeconds === undefined
            ? {}
            : { leaseTtlSeconds: allowlist.leaseTtlSeconds }),
      };
      host = new CeSessionHost(store, policy);
    }
    return host;
  };

  /** The last persisted mapping entry, if any. Only inspected for reasons
   * where adoption is safe; fork/new reasons must never inherit it. */
  const lastMappingEntry = (ctx: ExtensionContextView): unknown => {
    let found: unknown;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "ce-mapping") found = entry.data;
    }
    return found;
  };

  pi.on("session_start", async (event, ctx) => {
    const piSessionId = ctx.sessionManager.getSessionId();
    const endpointId = endpointForPiSession(allowlist, piSessionId);
    if (endpointId === undefined) {
      notify(ctx, `ce-chat-exchange: Pi session is not in the allowlist; chat-exchange disabled`, "warning");
      return;
    }
    currentEndpoint = endpointId;

    try {
      const sessionHost = getHost();
      const adoptable = event.reason === "startup" || event.reason === "reload" || event.reason === "resume";
      const inherited = adoptable ? lastMappingEntry(ctx) : undefined;
      const mapping: CeMappingIdentifiers =
        inherited !== undefined
          ? sessionHost.resume(endpointId, inherited)
          : sessionHost.beginSession(endpointId);
      // Persist identifiers only; never credentials.
      pi.appendEntry("ce-mapping", mapping);
      startupFailure = undefined;
      notify(
        ctx,
        `ce-chat-exchange: endpoint ${mapping.endpointId} bound (participant ${mapping.participantId}, session ${mapping.sessionId})`,
      );
    } catch (error) {
      startupFailure =
        error instanceof CeHostRefusal ? error : new CeHostRefusal("CE_HOST_UNAVAILABLE");
      notify(ctx, `ce-chat-exchange: session start failed closed (${startupFailure.code})`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (currentEndpoint !== undefined && host !== undefined) {
      host.drop(currentEndpoint);
    }
    currentEndpoint = undefined;
    startupFailure = undefined;
  });

  const refusalResult = (error: unknown): ToolResultView => {
    if (error instanceof CeHostRefusal) {
      return {
        content: [
          {
            type: "text",
            text: `chat-exchange refused: ${error.code}${error.reason === undefined ? "" : ` (${error.reason})`}${error.retryable ? "; rolled back, safe to retry whole request" : ""}`,
          },
        ],
        details: { code: error.code, reason: error.reason ?? null, retryable: error.retryable },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: "chat-exchange failed closed (CE_HOST_UNAVAILABLE)" }],
      details: { code: "CE_HOST_UNAVAILABLE", reason: null, retryable: false },
      isError: true,
    };
  };

  pi.registerTool({
    name: "ce_send",
    label: "Chat Exchange Send",
    description:
      "Send one durable chat-exchange message to an allowlisted local endpoint. " +
      "The send is Session-authorized, idempotent by idempotencyKey, and commits the " +
      "Message with its audit event in one transaction. Returns metadata only.",
    promptSnippet: "Send a durable local chat-exchange message to an allowlisted endpoint",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient endpoint label from the host allowlist" },
        text: { type: "string", description: "Message text; stored as the private payload" },
        idempotencyKey: { type: "string", description: "Stable key; replays return the original message" },
      },
      required: ["to", "text", "idempotencyKey"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params): Promise<ToolResultView> {
      try {
        if (startupFailure !== undefined) {
          return refusalResult(startupFailure);
        }
        if (currentEndpoint === undefined) {
          return refusalResult(new CeHostRefusal("CE_HOST_NOT_REGISTERED"));
        }
        const result = getHost().send(currentEndpoint, params);
        return {
          content: [
            {
              type: "text",
              text: `chat-exchange ${result.disposition.toLowerCase()}: message ${result.messageId} to ${result.recipient} (audit #${result.auditSequence})`,
            },
          ],
          details: { ...result },
        };
      } catch (error) {
        return refusalResult(error);
      }
    },
  });

  pi.registerTool({
    name: "ce_read",
    label: "Chat Exchange Read",
    description:
      "Read protected metadata of one chat-exchange message addressed to this endpoint. " +
      "Returns metadata only (no payload bytes). The messageId must be provided explicitly; " +
      "there is no inbox discovery.",
    promptSnippet: "Read metadata of a durable chat-exchange message by explicit message id",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Explicit message id previously returned by ce_send" },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params): Promise<ToolResultView> {
      try {
        if (startupFailure !== undefined) {
          return refusalResult(startupFailure);
        }
        if (currentEndpoint === undefined) {
          return refusalResult(new CeHostRefusal("CE_HOST_NOT_REGISTERED"));
        }
        const result = getHost().readMetadata(currentEndpoint, params);
        return {
          content: [
            {
              type: "text",
              text:
                `chat-exchange message ${result.messageId}: from ${result.from} to ${result.to}, ` +
                `state ${result.state}, ${result.payloadLength} bytes (sha256 ${result.payloadDigest}), ` +
                `created ${result.createdAt}, audit #${result.auditSequence}. Payload is not exposed by this read.`,
            },
          ],
          details: { ...result },
        };
      } catch (error) {
        return refusalResult(error);
      }
    },
  });

  pi.registerCommand("ce-status", {
    description: "Show this session's chat-exchange endpoint, ownership lease, and fencing status",
    async handler(_args, ctx) {
      if (startupFailure !== undefined) {
        notify(ctx, `ce-chat-exchange: session start failed closed (${startupFailure.code})`, "warning");
        return;
      }
      if (currentEndpoint === undefined) {
        notify(ctx, "ce-chat-exchange: no endpoint bound for this Pi session", "warning");
        return;
      }
      let status;
      try {
        status = getHost().status(currentEndpoint);
      } catch {
        notify(ctx, "ce-chat-exchange: status unavailable (CE_HOST_UNAVAILABLE)", "warning");
        return;
      }
      notify(
        ctx,
        `ce-chat-exchange: endpoint=${status.endpointId} registered=${status.registered} ` +
          `participant=${status.participantId ?? "none"} session=${status.sessionId ?? "none"} ` +
          `lease=${status.lease} fencing=${status.fencingToken ?? "none"}`,
      );
    },
  });
}
