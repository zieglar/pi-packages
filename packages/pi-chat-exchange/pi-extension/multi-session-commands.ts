/** Operator-only, configuration-only commands. Never polls inboxes or controls transport. */
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { createMultiSessionRegistration, readSelectedMultiSessionPolicy } from "../dist/tunnel/multi-session-policy.js";
import { readGeneratedPiAllowlist } from "../dist/tunnel/setup.js";
import { TunnelRefusal } from "../dist/tunnel/codes.js";
import type { BackgroundTunnelManager } from "../dist/tunnel/background-manager.js";
import { runtimeEnvironment } from "./multi-session-runtime.js";

interface CommandPort {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly sessionManager: { getSessionId(): string };
  readonly ui: { confirm?(title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>; notify(message: string, level: "info" | "warning" | "error"): void };
}
const safe = (s: string): string => sanitizeTerminalText(s).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function refuse(): never { throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT"); }
export async function runSessionConfiguration(args: string, ctx: CommandPort, options: {
  readonly profilePath: string;
  readonly manager: BackgroundTunnelManager;
  readonly signal: AbortSignal;
  /** Trusted runtime composition keeps enumeration AND publication admitted. */
  readonly withTargetAdmission: <T>(operation: () => T) => T;
}): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) throw new TunnelRefusal("CE_TUNNEL_INPUT_UNAVAILABLE");
  const words = args.trim().split(/\s+/); const [command, endpointId, ...flags] = words;
  const api = createMultiSessionRegistration({ profilePath: options.profilePath, env: process.env, manager: {
    withProfileConfigurationLock: operation => options.manager.withProfileConfigurationLock(guard => {
      current(); // lock acquisition/process inventory may await; fence again inside it
      return operation(guard);
    }),
  } });
  const expectedRevision = api.revision();
  const runtimeSessionId = ctx.sessionManager.getSessionId();
  const environment = runtimeEnvironment();
  const current = (): void => {
    if (options.signal.aborted || runtimeEnvironment() !== environment || ctx.sessionManager.getSessionId() !== runtimeSessionId || api.revision() !== expectedRevision) refuse();
  };
  const confirm = async (message: string): Promise<boolean> => {
    current();
    if (typeof ctx.ui.confirm !== "function") throw new TunnelRefusal("CE_TUNNEL_INPUT_UNAVAILABLE");
    const accepted = await ctx.ui.confirm("Chat Exchange · configuration only", message, { signal: options.signal, timeout: 120_000 });
    current(); return accepted === true;
  };
  if (command === "sessions") {
    if (words.length !== 1) refuse();
    return options.withTargetAdmission(() => {
      const selected = readSelectedMultiSessionPolicy(options.profilePath); current();
      // No await between admission, target discovery and the operator notice.
      ctx.ui.notify("ce-tunnel: selected configured active Endpoint IDs (copy exactly to ce_send.to): " +
        selected.manifest.registrations.filter(r => r.status === "active").map(r => safe(r.endpointId)).join(", ") +
        ". MCP loaded: unknown; controlled Stop then Start required to load grants. Pi grants require explicit extension reload. " +
        "Shared chatgpt/main inbox; not conversation isolation. Configured != Connected.", "info");
    });
  }
  // An explicit legacy override cannot silently become a new-mode runtime.
  if (process.env.CE_ALLOWLIST) refuse();
  if (command === "convert") {
    if (words.length !== 1) refuse();
    const legacy = readGeneratedPiAllowlist(options.profilePath);
    if (legacy === undefined) refuse();
    if (!await confirm("Legacy conversion cannot revoke old binaries without the new gates. I acknowledge that ALL old legacy bindings/runtimes have been stopped or updated. No global revocation is promised.")) return;
    if (!await confirm("Explicitly convert the existing single-session registration to multi-session mode, preserving its Endpoint, real Session mapping, Store, Exchange and read/ACK grants? Existing registration: " + safe(JSON.stringify(legacy.sessions)) +
      ". Other sessions will require distinct Endpoints and separate confirmation. Shared ChatGPT inbox is not conversation isolation.")) return;
    current();
    const result = await api.convert({ expectedRevision, confirm: true });
    ctx.ui.notify(`ce-tunnel: multi-session configuration selected (${result.durability}); reload Pi explicitly; explicit Stop then Start loads MCP grants. Configured only, not delivery evidence.`, "warning");
    return;
  }
  if ((command !== "register" && command !== "revoke") || typeof endpointId !== "string" || endpointId.length > 256 ||
      /[\x00-\x20\x7f-\x9f]/.test(endpointId) || /cap_[0-9a-f]{16,}/i.test(endpointId)) refuse();
  const selected = readSelectedMultiSessionPolicy(options.profilePath);
  let message: string;
  if (command === "register") {
    if (!runtimeSessionId || new Set(flags).size !== flags.length || flags.some(f => f !== "--payload-read" && f !== "--ack")) refuse();
    message = `Register ONLY current trusted Pi Session ${safe(runtimeSessionId)} as exact Endpoint ${safe(endpointId)}?\n` +
      `Store: ${safe(selected.manifest.store.directory)}/${safe(selected.manifest.store.file)}\n` +
      `Exchange: ${safe(selected.manifest.exchange.namespace)} / ${safe(selected.manifest.exchange.idempotencyKey)}\n` +
      `Peer: ${safe(selected.manifest.chatgptEndpoint.endpointId)}; payload read=${flags.includes("--payload-read")}; ACK=${flags.includes("--ack")} (reception only).\n` +
      "Shared ChatGPT inbox, not conversation isolation. Publication only; explicit Pi reload and separate transport Start required.";
  } else {
    if (flags.length !== 0) refuse();
    const r = selected.manifest.registrations.find(r => r.endpointId === endpointId && r.status === "active");
    if (r === undefined) refuse();
    message = `Revoke exact stable Endpoint ${safe(endpointId)} (Session ${safe(r.runtimeSessionId)}, epoch ${r.epoch})?\n` +
      "New-gated runtime operations will be denied after publication; already admitted operations may finish. Other registrations and shared ChatGPT history remain. No retroactive removal or old-binary revocation.";
  }
  if (!await confirm(message)) return;
  current();
  const result = command === "register"
    ? await api.register({ expectedRevision, registration: { endpointId, runtimeSessionId, payloadRead: flags.includes("--payload-read"), ack: flags.includes("--ack") } })
    : await api.revoke({ expectedRevision, endpointId });
  ctx.ui.notify(`ce-tunnel: selected configuration saved (${result.durability}); reload Pi explicitly to load grants; MCP loaded: unknown, use controlled Stop then Start. No transport lifecycle side effects.`, "warning");
}
