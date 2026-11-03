/** Operator-only, configuration-only commands. Never polls inboxes or controls transport. */
import { readFileSync } from "node:fs";
import { createLivePolicyRegistration, type LiveSnapshot } from "../dist/tunnel/live-session-policy.js";
import { readLiveSelectedSessionPolicy } from "./live-session-profile.js";
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
  if (command === "liveSessions") {
    if (words.length !== 1 || options.signal.aborted || process.env.CE_ALLOWLIST) refuse();
    return options.withTargetAdmission(() => {
      const runtime = ctx.sessionManager.getSessionId();
      const text = readFileSync(options.profilePath, "utf8");
      const selected = readLiveSelectedSessionPolicy(options.profilePath, text);
      if (selected === undefined) refuse();
      const own = selected.manifest.registrations.find(r => r.runtimeSessionId === runtime && r.status === "active");
      if (own === undefined || options.signal.aborted || ctx.sessionManager.getSessionId() !== runtime) refuse();
      ctx.ui.notify(`ce-tunnel: own Endpoint ${safe(own.endpointId)}; payload read=${own.payloadRead}; ACK=${own.ack}. ` +
        "Discovery unavailable; Active=unknown; Reachable=unknown. Registered is not delivery or task completion evidence. " +
        "Choose the exact intended recipient; no latest-Session or pi/main fallback.", "info");
    });
  }
  if (command === "register" || command === "revoke" || command === "reauthorize") {
    const text = readFileSync(options.profilePath, "utf8");
    const selected = readLiveSelectedSessionPolicy(options.profilePath, text);
    if (selected !== undefined) return liveConfiguration(command, endpointId, flags, ctx, options, selected, text);
    if (command === "reauthorize") refuse();
  }
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
      "Hooks are preserved only if separately authorized; registration enables no Hooks. Exact Endpoint labels are visible to the configured peer; real first send outcomes may reveal first join/addressability. " +
      "Shared ChatGPT inbox, not conversation isolation. Publication only; explicit Pi reload and separate transport Start required. No delivery or task execution is implied.";
  } else {
    if (flags.length !== 0) refuse();
    const r = selected.manifest.registrations.find(r => r.endpointId === endpointId && r.status === "active");
    if (r === undefined) refuse();
    message = `Revoke exact stable Endpoint ${safe(endpointId)} (Session ${safe(r.runtimeSessionId)}, epoch ${r.epoch})?\n` +
      "New-gated runtime operations will be denied after publication; already admitted operations may finish. Other registrations and shared ChatGPT history remain. No retroactive removal or old-binary revocation. " +
      "Reauthorization requires fresh explicit confirmation and a new runtime projection; Connect cannot restore a revoked registration.";
  }
  if (!await confirm(message)) return;
  current();
  const result = command === "register"
    ? await api.register({ expectedRevision, registration: { endpointId, runtimeSessionId, payloadRead: flags.includes("--payload-read"), ack: flags.includes("--ack") } })
    : await api.revoke({ expectedRevision, endpointId });
  ctx.ui.notify(`ce-tunnel: selected configuration saved (${result.durability}); reload Pi explicitly to load grants; MCP loaded: unknown, use controlled Stop then Start. No transport lifecycle side effects.`, "warning");
}

async function liveConfiguration(command: "register" | "revoke" | "reauthorize", endpointId: string | undefined, flags: readonly string[], ctx: CommandPort,
  options: Parameters<typeof runSessionConfiguration>[2], selected: LiveSnapshot, profileText: string): Promise<void> {
  if (process.env.CE_ALLOWLIST || typeof endpointId !== "string" || endpointId.length > 256 || /[\x00-\x20\x7f-\x9f]/.test(endpointId) || /cap_[0-9a-f]{16,}/i.test(endpointId)) refuse();
  const runtimeSessionId = ctx.sessionManager.getSessionId(); const environment = runtimeEnvironment();
  const api = createLivePolicyRegistration({ ref: selected.ref });
  const current = (): void => {
    if (options.signal.aborted || ctx.sessionManager.getSessionId() !== runtimeSessionId || runtimeEnvironment() !== environment ||
      readFileSync(options.profilePath, "utf8") !== profileText) refuse();
  };
  const own = selected.manifest.registrations.find(r => r.runtimeSessionId === runtimeSessionId);
  if (api.reconcile({ runtimeSessionId }).some(r => r.outcome === "NOT_OBSERVED" || r.outcome === "UNKNOWN")) refuse();
  if (typeof ctx.ui.confirm !== "function") throw new TunnelRefusal("CE_TUNNEL_INPUT_UNAVAILABLE");
  current();
  if ((command === "register" || command === "reauthorize") &&
    (flags.includes("--payload-read") && !selected.manifest.mcp.payloadRead || flags.includes("--ack") && !selected.manifest.mcp.ack)) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.livePolicy.globalCeiling");
  }
  if (command === "reauthorize") {
    if (!runtimeSessionId || own?.status !== "revoked" || own.endpointId !== endpointId ||
      new Set(flags).size !== flags.length || flags.some(f => f !== "--payload-read" && f !== "--ack")) refuse();
    const payloadRead = flags.includes("--payload-read"); const ack = flags.includes("--ack");
    if (!await ctx.ui.confirm("Chat Exchange · reauthorize current Session", `Reauthorize exact Endpoint ${safe(endpointId)} for ONLY this current native Session? Epoch ${own.epoch} -> ${own.epoch + 1}; payload read=${payloadRead}; ACK=${ack} (reception only). ` +
      "Hooks are preserved unchanged. Exact labels are visible to the peer; real send outcomes may reveal first join/addressability. Old factories remain denied until official reload. " +
      "No Owner, capability or takeover changes. A held/expired old Owner requires normal release or separate operator recovery. No delivery or task execution is implied.", { signal: options.signal, timeout: 120_000 })) return;
    current();
    const presenceDisclosure = await ctx.ui.confirm("Chat Exchange · optional presence disclosure", "Also disclose Exchange membership/first join and current Owner/lease liveness to authorized peers? Decline keeps presence-dependent Active/Reachable unknown.", { signal: options.signal, timeout: 120_000 });
    current();
    const result = await api.reauthorize({ expectedDigest: selected.digest, registration: { endpointId, runtimeSessionId, payloadRead, ack, presenceDisclosure: presenceDisclosure === true } });
    ctx.ui.notify(`ce-tunnel: reauthorization saved (${result.durability}); official reload required; old factories remain denied. No Owner recovery or transport action.`, "warning");
  } else if (command === "register") {
    if (!runtimeSessionId || own?.status === "revoked" || selected.manifest.registrations.some(r => r.endpointId === endpointId && r !== own) ||
      new Set(flags).size !== flags.length || flags.some(f => f !== "--payload-read" && f !== "--ack")) refuse();
    const payloadRead = flags.includes("--payload-read"); const ack = flags.includes("--ack");
    if (!await ctx.ui.confirm("Chat Exchange · live configuration only", `Register current Session as ${safe(endpointId)}; payload read=${payloadRead}; ACK=${ack}. ` +
      "Presence disclosure remains disabled unless separately consented. Hooks are preserved, never enabled. Publication is not delivery or task completion evidence.", { signal: options.signal, timeout: 120_000 })) return;
    current();
    const result = await api.register({ expectedDigest: selected.digest, registration: { endpointId, runtimeSessionId, payloadRead, ack, presenceDisclosure: false } });
    ctx.ui.notify(`ce-tunnel: live registration saved (${result.durability}); explicit reload is required. No transport action or delivery claim.`, "warning");
  } else {
    if (flags.length !== 0) refuse();
    const r = selected.manifest.registrations.find(r => r.endpointId === endpointId && r.status === "active");
    if (r === undefined || !await ctx.ui.confirm("Chat Exchange · live configuration only", `Revoke exact Endpoint ${safe(endpointId)}? Already admitted operations may finish; reauthorization requires a fresh explicit confirmation. Revoking the last registration can permanently stop MCP renewal for this incarnation. An expired Owner requires separate operator recovery; no automatic takeover or heartbeat restart.`, { signal: options.signal, timeout: 120_000 })) return;
    current();
    const result = await api.revoke({ expectedDigest: selected.digest, endpointId });
    ctx.ui.notify(`ce-tunnel: live registration revoked (${result.durability}); explicit reload is required. No transport action.`, "warning");
  }
}
