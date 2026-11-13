import { readFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseTunnelProfile } from "../dist/tunnel/background-manager.js";
import { parseTunnelMcpCommand } from "../dist/tunnel/profile.js";
import { readMessagingGeneration } from "../dist/tunnel/messaging-config.js";
import { createEndpointRuntimeBinding, normalizeRuntimeGroup, type RuntimeSelection } from "../dist/tunnel/endpoint-runtime-binding.js";
import { discoverCurrentRuntimes } from "../dist/tunnel/current-runtime-binding.js";
import type { LivePolicyRef } from "../dist/tunnel/live-session-policy.js";
import { readLiveSelectedSessionPolicy } from "./live-session-profile.js";

interface CommandContext {
  readonly hasUI: boolean;
  readonly sessionManager: {getSessionId(): string};
  readonly ui: {
    notify(message: string, level: "info" | "warning"): void;
    confirm?(title: string, message: string): Promise<boolean>;
  };
}
interface RuntimeContext {
  readonly profilePath?: string;
  readonly profileText?: string;
  readonly ref?: LivePolicyRef;
  readonly runtimeId: string;
  readonly isCurrent: () => boolean;
}
const scopeNotice = "CE Endpoint-level binding shared by all callers of this launch; no ChatGPT conversation identity is attested; no permissions granted";
const refuse = (code: string): never => {throw Error(`CE_BIND_${code}`);};

/** Local operator command only. Caller scope comes from the loaded private launch,
 * never command arguments, message metadata or a global latest Runtime. */
export async function runRuntimeBindingCommand(args: string, ctx: CommandContext, runtime: RuntimeContext): Promise<void> {
  try {
    let parsed;
    try {parsed = parseArgs({args: args.trim() ? args.trim().split(/\s+/) : [], allowPositionals: true,
      options: {"expected-revision": {type: "string"}, "accept-endpoint-scope": {type: "boolean"}}});}
    catch {return refuse("INVALID");}
    const [action = "status", rawGroup, rawNext] = parsed.positionals, values = parsed.values;
    if (!["status", "bind", "rebind", "revoke", "rename"].includes(action) ||
      (action === "rename" ? parsed.positionals.length !== 3 : parsed.positionals.length > 2) ||
      action === "status" && Object.keys(values).length > 0 ||
      values["expected-revision"] !== undefined && !/^(unbound|[a-f0-9]{64})$/.test(values["expected-revision"]) ||
      values["accept-endpoint-scope"] && values["expected-revision"] === undefined) return refuse("INVALID");
    const group = rawGroup === undefined ? undefined : normalizeRuntimeGroup(rawGroup);
    const nextName = rawNext === undefined ? undefined : normalizeRuntimeGroup(rawNext);
    if (runtime.profilePath === undefined || runtime.profileText === undefined || runtime.ref === undefined) return refuse("SCOPE_UNAVAILABLE");
    const profilePath = runtime.profilePath, sessionId = ctx.sessionManager.getSessionId();
    // Pin the launch selected when the extension loaded, including changes made
    // before this command starts. A new generation requires explicit reload.
    const profile = runtime.profileText;
    const assertCurrent = (): void => {
      if (!runtime.isCurrent() || ctx.sessionManager.getSessionId() !== sessionId || readFileSync(profilePath, "utf8") !== profile) refuse("CONTEXT_CHANGED");
    };
    assertCurrent();
    const snapshot = readLiveSelectedSessionPolicy(profilePath, profile);
    if (snapshot === undefined || !isDeepStrictEqual(snapshot.ref, runtime.ref)) return refuse("SCOPE_UNAVAILABLE");
    const facts = parseTunnelProfile(profile);
    if (facts.mcpCommand === undefined) return refuse("SCOPE_UNAVAILABLE");
    const bindingPath = parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
    const pair = readMessagingGeneration(profilePath, bindingPath, facts.keyFile);
    if (pair === undefined || pair.config.endpoint.adapter !== "chatgpt" || !isDeepStrictEqual(pair.config.admissionPolicy, runtime.ref)) return refuse("SCOPE_UNAVAILABLE");
    const binding = createEndpointRuntimeBinding(bindingPath, pair.config), before = group === undefined ? binding.read() : binding.readGroup(group);
    if (before.status === "unavailable") return refuse("SCOPE_UNAVAILABLE");
    const visible = snapshot.manifest.registrations.filter(r => r.status === "active" && r.presenceDisclosure).map(r => r.endpointId);
    const describe = (selection: RuntimeSelection): string => {
      if (selection.status === "unavailable") return refuse("SCOPE_UNAVAILABLE");
      const target = selection.status === "bound" ? discoverCurrentRuntimes(snapshot, visible, selection.runtimeId).currentBinding : undefined;
      return `group=${selection.group ?? "(legacy)"}; selection=${selection.status}; revision=${selection.revision}` +
        (selection.status === "bound" ? `; boundRuntime=${selection.runtimeId}` : "") +
        (action === "status" ? `; target=${target?.status ?? "unbound"}${target?.status === "verified" ? `; endpoint=${target.endpointId}` : ""}` : "");
    };
    const show = (selections: RuntimeSelection[]): void => ctx.ui.notify(
      `ce-bind: ${scopeNotice}\ncaller=${pair.config.endpoint.endpointId}; thisRuntime=${runtime.runtimeId}\n${selections.map(describe).join("\n")}`, "info");
    if (action === "status") {show(group === undefined ? [before, ...binding.listGroups()] : [before]); return;}
    const expectedRevision = values["expected-revision"] ?? before.revision;
    if (expectedRevision !== before.revision) return refuse("CONFLICT");
    if (action === "bind" && before.status === "bound") return refuse("USE_REBIND");
    if ((action === "rebind" || action === "revoke") && before.status === "unbound") return refuse("ALREADY_UNBOUND");
    // Consent covers the exact revision displayed here. A competing operator is
    // resolved by the existing CAS writer; never reread and retry a mutation.
    if (!values["accept-endpoint-scope"]) {
      if (!ctx.hasUI || ctx.ui.confirm === undefined) return refuse("CONFIRMATION_REQUIRED");
      const accepted = await ctx.ui.confirm("CE Runtime binding", `${scopeNotice}\n${action}: caller=${pair.config.endpoint.endpointId}; group=${group ?? "(legacy)"}${nextName === undefined ? "" : `; newGroup=${nextName}`}; previous=${before.status === "bound" ? before.runtimeId : "unbound"}; next=${action === "rename" ? "same Runtime" : action === "revoke" ? "unbound" : runtime.runtimeId}; revision=${expectedRevision}`);
      if (!accepted) {ctx.ui.notify("ce-bind: cancelled", "info"); return;}
    }
    assertCurrent();
    if (action === "bind" || action === "rebind") {
      const fresh = readLiveSelectedSessionPolicy(profilePath, profile);
      if (fresh === undefined || !isDeepStrictEqual(fresh.ref, runtime.ref)) return refuse("SCOPE_UNAVAILABLE");
      const registration = fresh.manifest.registrations.find(r => r.runtimeSessionId === sessionId && r.status === "active" && r.presenceDisclosure);
      const current = discoverCurrentRuntimes(fresh, registration === undefined ? [] : [registration.endpointId], runtime.runtimeId).currentBinding;
      if (registration === undefined || current?.status !== "verified" || current.endpointId !== registration.endpointId) return refuse("RUNTIME_UNAVAILABLE");
    }
    const result = group === undefined
      ? binding.update({runtimeId: action === "revoke" ? null : runtime.runtimeId, expectedRevision, acceptEndpointScope: true})
      : binding.updateGroup({action, group, ...(action === "rename" ? {nextName} : {}),
        ...(action === "bind" || action === "rebind" ? {runtimeId: runtime.runtimeId} : {}), expectedRevision, acceptEndpointScope: true});
    if (result.status === "unavailable") return refuse("SCOPE_UNAVAILABLE");
    show([result]);
  } catch (error) {
    const code = error instanceof Error && /^CE_(BIND_(INVALID|SCOPE_UNAVAILABLE|CONTEXT_CHANGED|CONFLICT|USE_REBIND|ALREADY_UNBOUND|CONFIRMATION_REQUIRED|RUNTIME_UNAVAILABLE)|RUNTIME_BINDING_(INVALID|CONFLICT|RUNTIME_UNAVAILABLE|WRITE_UNCERTAIN|GROUP_EXISTS|GROUP_UNBOUND|GROUP_LIMIT))$/.test(error.message)
      ? error.message : "CE_BIND_SCOPE_UNAVAILABLE";
    ctx.ui.notify(`ce-bind: refused (${code})`, "warning");
  }
}
