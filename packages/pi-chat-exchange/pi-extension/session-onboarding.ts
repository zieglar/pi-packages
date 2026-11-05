/** Configuration-only onboarding. Transport and messaging authority stay with Connect. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readLivePolicy, createLivePolicyRegistration, type LiveSnapshot } from "../dist/tunnel/live-session-policy.js";
import { readLiveSelectedSessionPolicy } from "./live-session-profile.js";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { createMultiSessionRegistration, readSelectedMultiSessionPolicy } from "../dist/tunnel/multi-session-policy.js";
import type { BackgroundTunnelManager } from "../dist/tunnel/background-manager.js";
import { runtimeEnvironment } from "./multi-session-runtime.js";

export type SessionOnboardingReason = "legacy-override" | "multi-session-policy-required" | "registration-revoked" |
  "global-ceiling-disabled" | "endpoint-collision" | "input-unavailable" | "context-changed" | "transport-running" | "transport-unknown" | "durability-uncertain";
export class SessionOnboardingRefusal extends Error {
  readonly reason: SessionOnboardingReason;
  constructor(reason: SessionOnboardingReason, message: string) {
    super(message); this.name = "SessionOnboardingRefusal"; this.reason = reason;
  }
}
interface OnboardingContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly sessionManager: { getSessionId(): string };
  readonly ui: {
    confirm?(title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}
const safe = (text: string): string => sanitizeTerminalText(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export async function prepareSessionOnboarding(ctx: OnboardingContext, options: {
  readonly profilePath: string;
  readonly manager: Pick<BackgroundTunnelManager, "refresh" | "withProfileConfigurationLock">;
  readonly signal: AbortSignal;
  readonly onProgress?: (text: string) => void;
}): Promise<"ready" | "registered" | "cancelled"> {
  if (options.signal.aborted) return "cancelled";
  if (process.env.CE_ALLOWLIST) throw new SessionOnboardingRefusal("legacy-override", "CE_ALLOWLIST selects legacy policy. Remove the override and explicitly select a multi-session profile before Connect.");
  let selected;
  try {
    try { selected = readSelectedMultiSessionPolicy(options.profilePath); }
    catch {
      const text = readFileSync(options.profilePath, "utf8");
      const live = readLiveSelectedSessionPolicy(options.profilePath, text);
      if (live === undefined) throw new Error("No selected policy");
      return prepareLiveSession(ctx, options, live, text);
    }
  }
  catch { throw new SessionOnboardingRefusal("multi-session-policy-required", "A verified multi-session policy is required. Configure or explicitly convert the selected profile before Connect."); }
  const runtimeSessionId = ctx.sessionManager.getSessionId();
  if (typeof runtimeSessionId !== "string" || !runtimeSessionId.length || runtimeSessionId.length > 256 || /[\x00-\x1f\x7f]/.test(runtimeSessionId) || /cap_[0-9a-f]{16,}/i.test(runtimeSessionId)) {
    throw new SessionOnboardingRefusal("context-changed", "A valid current native Pi Session is required. Resume that Session and Connect again.");
  }
  const old = selected.manifest.registrations.find(r => r.runtimeSessionId === runtimeSessionId);
  if (old?.status === "revoked") throw new SessionOnboardingRefusal("registration-revoked", "This Pi Session registration was revoked. Ask the operator to resolve its registration explicitly; Connect cannot restore it.");
  if (old !== undefined) return "ready";
  const endpointId = "pi/session-" + createHash("sha256").update(JSON.stringify(["ce-session-onboarding-v1", runtimeSessionId])).digest("hex").slice(0, 32);
  if (selected.manifest.chatgptEndpoint.endpointId === endpointId || selected.manifest.registrations.some(r => r.endpointId === endpointId)) {
    throw new SessionOnboardingRefusal("endpoint-collision", "The generated Endpoint already belongs to an existing registration or tombstone. Ask the operator to resolve the collision; nothing was overwritten.");
  }
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.confirm !== "function") throw new SessionOnboardingRefusal("input-unavailable", "Open an interactive Pi TUI and Connect to confirm this Session registration.");
  const environment = runtimeEnvironment();
  const expectedRevision = selected.revision;
  const api = createMultiSessionRegistration({ profilePath: options.profilePath, env: process.env, manager: {
    withProfileConfigurationLock: operation => options.manager.withProfileConfigurationLock(guard => {
      current(); // Lock acquisition includes an awaited process inventory; fence before publication.
      return operation(guard);
    }),
  } });
  const current = (): void => {
    if (options.signal.aborted || ctx.sessionManager.getSessionId() !== runtimeSessionId || runtimeEnvironment() !== environment || api.revision() !== expectedRevision) {
      throw new SessionOnboardingRefusal("context-changed", "Session, profile, environment or cancellation changed during onboarding. Connect again to review the current configuration.");
    }
  };
  options.onProgress?.("Measuring transport before session registration");
  const status = await options.manager.refresh();
  if (options.signal.aborted) return "cancelled";
  current();
  if (status.state === "UNKNOWN" || status.state === "STOPPED" && status.running) {
    throw new SessionOnboardingRefusal("transport-unknown", "Transport state is unverified. Resolve process/ownership inspection and verify STOPPED before Connect.");
  }
  if (status.state !== "STOPPED") throw new SessionOnboardingRefusal("transport-running", "This current Pi Session is absent from the loaded recipient policy of the running transport. Coordinate Stop then Connect to register and load its Endpoint.");
  // A never-started profile has STOPPED/none; the existing lock verifies process absence.
  options.onProgress?.("Verifying the Profile configuration lock");
  try { await options.manager.withProfileConfigurationLock(() => current()); }
  catch (error) {
    if (error instanceof SessionOnboardingRefusal) throw error;
    throw new SessionOnboardingRefusal("transport-unknown", "STOPPED process absence and ownership could not be verified. Resolve transport inspection before Connect.");
  }
  if (options.signal.aborted) return "cancelled";
  current();
  options.onProgress?.("Waiting for session registration consent");
  const accepted = await ctx.ui.confirm("Chat Exchange · register current Session", `Register this current native Pi Session as Endpoint ${safe(endpointId)}?\n` +
    `Store: ${safe(selected.manifest.store.directory)}/${safe(selected.manifest.store.file)}\n` +
    `Exchange: ${safe(selected.manifest.exchange.namespace)} / ${safe(selected.manifest.exchange.idempotencyKey)}\n` +
    `Peer: ${safe(selected.manifest.chatgptEndpoint.endpointId)}\n` +
    "Payload read: disabled; ACK: disabled; Hooks: none.\nShared ChatGPT inbox; registration saves configuration only. Connect separately checks transport permission and messaging ownership.",
    { signal: options.signal, timeout: 120_000 });
  if (options.signal.aborted) return "cancelled";
  current();
  if (accepted !== true) return "cancelled";
  options.onProgress?.("Saving the session registration");
  const result = await api.register({ expectedRevision, registration: { endpointId, runtimeSessionId, payloadRead: false, ack: false } });
  // Publication changes revision itself. Never retry or claim rollback after its commit point.
  if (result.durability !== "synced") throw new SessionOnboardingRefusal("durability-uncertain", "Registration durability is uncertain. Inspect the selected profile before another Connect; do not retry registration automatically.");
  if (options.signal.aborted || ctx.sessionManager.getSessionId() !== runtimeSessionId || runtimeEnvironment() !== environment || api.revision() !== result.revision) {
    throw new SessionOnboardingRefusal("context-changed", "Context changed after registration publication. Inspect the selected profile and Connect again in the intended Session.");
  }
  return "registered";
}

async function prepareLiveSession(ctx: OnboardingContext, options: Parameters<typeof prepareSessionOnboarding>[1], selected: LiveSnapshot, profileText: string): Promise<"ready" | "registered" | "cancelled"> {
  const runtimeSessionId = ctx.sessionManager.getSessionId();
  if (typeof runtimeSessionId !== "string" || !runtimeSessionId.length || runtimeSessionId.length > 256 || /[\x00-\x1f\x7f]/.test(runtimeSessionId) || /cap_[0-9a-f]{16,}/i.test(runtimeSessionId)) {
    throw new SessionOnboardingRefusal("context-changed", "A valid current native Pi Session is required.");
  }
  if (!selected.manifest.mcp.payloadRead || !selected.manifest.mcp.ack) throw new SessionOnboardingRefusal("global-ceiling-disabled", "Global MCP payload-read or ACK is disabled. Enable both through explicit offline setup before live Connect; no Session grant was changed.");
  const old = selected.manifest.registrations.find(r => r.runtimeSessionId === runtimeSessionId);
  if (old?.status === "revoked") throw new SessionOnboardingRefusal("registration-revoked", "Connect cannot restore a revoked registration. Fresh operator confirmation is required.");
  if (old?.payloadRead && old.ack) return "ready";
  const endpointId = old?.endpointId ?? "pi/session-" + createHash("sha256").update(JSON.stringify(["ce-session-onboarding-v1", runtimeSessionId])).digest("hex").slice(0, 32);
  if (selected.manifest.chatgptEndpoint.endpointId === endpointId || selected.manifest.registrations.some(r => r.endpointId === endpointId && r !== old)) throw new SessionOnboardingRefusal("endpoint-collision", "Endpoint collision; nothing was overwritten.");
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.confirm !== "function") throw new SessionOnboardingRefusal("input-unavailable", "Open an interactive Pi TUI to confirm live messaging grants.");
  const api = createLivePolicyRegistration({ ref: selected.ref });
  if (api.reconcile({ runtimeSessionId }).some(r => r.outcome === "NOT_OBSERVED" || r.outcome === "UNKNOWN")) {
    throw new SessionOnboardingRefusal("durability-uncertain", "An earlier publication is unresolved. Reconcile it explicitly before new consent or publication.");
  }
  const environment = runtimeEnvironment();
  const current = (): void => {
    if (options.signal.aborted || ctx.sessionManager.getSessionId() !== runtimeSessionId || runtimeEnvironment() !== environment ||
      readFileSync(options.profilePath, "utf8") !== profileText || readLivePolicy(selected.ref).digest !== selected.digest) {
      throw new SessionOnboardingRefusal("context-changed", "Session, selected profile or policy changed; Connect again to review the current grants.");
    }
  };
  current();
  // The live chain owns publication serialization. No transport-STOPPED lock or lifecycle action.
  options.onProgress?.("Waiting for live session messaging consent");
  const accepted = await ctx.ui.confirm("Chat Exchange · current Session messaging", `Endpoint: ${safe(endpointId)}\n` +
    `Store: ${safe(selected.manifest.store.directory)}/${safe(selected.manifest.store.file)}\n` +
    `Exchange: ${safe(selected.manifest.exchange.namespace)} / ${safe(selected.manifest.exchange.idempotencyKey)}\nPeer: ${safe(selected.manifest.chatgptEndpoint.endpointId)}\n` +
    "Enable payload read and ACK (reception only) for this current Session? Its exact Endpoint label is visible to the configured peer. Real first send outcomes may reveal first join/addressability even when optional presence disclosure is withheld.\n" +
    (old?.hooks?.length ? "Separately authorized Hooks are preserved unchanged; no Hook is enabled by this consent.\n" : "Hooks: none.\n") +
    "Shared ChatGPT inbox; no conversation isolation. Configuration only: explicit reload/Start or transport reuse follows. This is not delivery or task completion evidence.", { signal: options.signal, timeout: 120_000 });
  if (options.signal.aborted) return "cancelled";
  current(); if (accepted !== true) return "cancelled";
  options.onProgress?.("Waiting for optional presence consent");
  const presenceDisclosure = old?.presenceDisclosure === true || await ctx.ui.confirm("Chat Exchange · optional presence disclosure", "Also disclose this Endpoint's Exchange membership/first join and current Owner/lease liveness to authorized peers? Decline keeps Active and membership-dependent Reachable unknown; messaging consent remains separate.", { signal: options.signal, timeout: 120_000 });
  if (options.signal.aborted) return "cancelled";
  current();
  options.onProgress?.("Publishing the live session registration");
  const result = api.register({ expectedDigest: selected.digest,
    registration: { endpointId, runtimeSessionId, payloadRead: true, ack: true, presenceDisclosure } });
  if (result.durability !== "synced") throw new SessionOnboardingRefusal("durability-uncertain", "Live registration publication is uncertain. Reconcile the operation explicitly; do not retry automatically.");
  if (options.signal.aborted || ctx.sessionManager.getSessionId() !== runtimeSessionId || runtimeEnvironment() !== environment || readFileSync(options.profilePath, "utf8") !== profileText || readLivePolicy(selected.ref).digest !== result.snapshot.digest) throw new SessionOnboardingRefusal("context-changed", "Context changed after publication. Grants remain configured; explicitly Connect again.");
  return "registered";
}
