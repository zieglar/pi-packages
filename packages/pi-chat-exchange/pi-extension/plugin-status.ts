import type { CeHookRule } from "../dist/hooks/config.js";
import { runHookStatusProbes, type CeHookStatusIdentity, type CeHookStatusResult } from "../dist/hooks/status-probe.js";

type StatusPort = {
  readonly mode: string;
  readonly ui: { readonly setStatus?: (key: string, text: string | undefined) => void };
};

type Runner = (rules: readonly CeHookRule[], identity?: CeHookStatusIdentity) => Promise<readonly CeHookStatusResult[]>;

export function formatPluginStatus(result: CeHookStatusResult): string {
  if (result.code === "NATIVE_SESSION_FILE_PENDING") return `${result.label} ◐ Pending`;
  if (result.state === "READY") return `${result.label} ● Ready`;
  if (result.state === "DEGRADED") return `${result.label} ! Degraded`;
  return `${result.label} ? Unknown`;
}

export function pluginSessionAnnotation(results: readonly CeHookStatusResult[]): string {
  return results.some(result => result.code === "NATIVE_SESSION_FILE_PENDING") ? " (Desktop pending)" : "";
}

export function pluginStatusLines(results: readonly CeHookStatusResult[]): readonly string[] {
  if (results.length === 0) return Object.freeze(["Session Plugins: none"]);
  const lines: string[] = ["Session Plugins"];
  for (const result of results) {
    lines.push("", result.label, `  Hook: ${result.hookId}`, `  Scope: ${result.scope}`,
      `  State: ${result.state}`, `  Code: ${result.code}`);
    if (result.code === "NATIVE_SESSION_FILE_PENDING") {
      lines.push("  Suggestion: Send the first normal message in this Session; Desktop status will refresh automatically after Pi creates the Session file.");
    }
  }
  return Object.freeze(lines);
}

export function desktopPluginDetailLines(pendingCount: number, status: { readonly state: string; readonly code: string }): readonly string[] {
  const count = Number.isSafeInteger(pendingCount) && pendingCount >= 0 ? pendingCount : 0;
  return Object.freeze([`  Pending Desktop deliveries: ${count}`,
    `  Desktop action state: ${status.state} (${status.code})`]);
}

export function desktopPendingMenuActions(state: string): readonly string[] {
  return state === "WAITING_FOR_OPERATOR"
    ? Object.freeze(["Retry once", "Dismiss", "Back"])
    : Object.freeze(["Back"]);
}

export function createPluginStatusController(options: { readonly run?: Runner } = {}) {
  const run = options.run ?? runHookStatusProbes;
  let epoch = 0;
  let port: StatusPort | undefined;
  let keys = new Set<string>();
  let results: readonly CeHookStatusResult[] = Object.freeze([]);
  const publish = (target: StatusPort | undefined, key: string, text: string | undefined): void => {
    if (target?.mode !== "tui") return;
    try { target.ui.setStatus?.(key, text); } catch { /* Advisory status never changes plugin or CE authority. */ }
  };
  const inspect = async (rules: readonly CeHookRule[], identity?: CeHookStatusIdentity): Promise<readonly CeHookStatusResult[]> => {
    const eligible = rules.filter(rule => rule.enabled && rule.status !== undefined);
    try { return await run(eligible, identity); }
    catch {
      return Object.freeze(eligible.map(rule => Object.freeze({ hookId: rule.id, label: rule.status!.label, scope: rule.scope,
        state: "UNKNOWN" as const, code: "PROBE_RUNNER_UNAVAILABLE" })));
    }
  };
  return {
    snapshot: (): readonly CeHookStatusResult[] => results,
    async inspect(rules: readonly CeHookRule[], identity?: CeHookStatusIdentity): Promise<readonly CeHookStatusResult[]> {
      return inspect(rules, identity);
    },
    async refresh(target: StatusPort, rules: readonly CeHookRule[], identity?: CeHookStatusIdentity): Promise<readonly CeHookStatusResult[]> {
      const captured = ++epoch;
      port = target;
      const eligible = rules.filter(rule => rule.enabled && rule.status !== undefined);
      const nextKeys = new Set(eligible.map(rule => `ce-plugin:${rule.id}`));
      for (const key of keys) if (!nextKeys.has(key)) publish(target, key, undefined);
      keys = nextKeys;
      results = Object.freeze([]);
      for (const rule of eligible) publish(target, `ce-plugin:${rule.id}`, `${rule.status!.label} ◐ Checking`);
      const observed = await inspect(eligible, identity);
      if (captured !== epoch) return Object.freeze([]);
      results = Object.freeze([...observed]);
      for (const result of observed) publish(target, `ce-plugin:${result.hookId}`, formatPluginStatus(result));
      return results;
    },
    clear(): void {
      ++epoch;
      for (const key of keys) publish(port, key, undefined);
      keys = new Set();
      results = Object.freeze([]);
      port = undefined;
    },
  };
}
