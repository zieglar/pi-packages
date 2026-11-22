import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { CeHookRule, CeHookScope, CeHookStatusProbe } from "./config.js";

export type CeHookStatusState = "READY" | "DEGRADED" | "UNKNOWN";

export interface CeHookStatusResult {
  readonly hookId: string;
  readonly label: string;
  readonly scope: CeHookScope;
  readonly state: CeHookStatusState;
  readonly code: string;
}

export interface CeHookStatusIdentity {
  readonly runtimeSessionId: string;
  readonly endpointId: string;
}

const output = (probe: CeHookStatusProbe, identity?: CeHookStatusIdentity): Promise<{ readonly state: CeHookStatusState; readonly code: string }> =>
  new Promise((resolve) => {
    execFile(probe.command, [...probe.args], {
      encoding: "utf8",
      env: { HOME: homedir(), PATH: "/opt/homebrew/bin:/usr/bin:/bin", LANG: "en_US.UTF-8",
        ...(identity === undefined ? {} : { CE_PLUGIN_STATUS_RUNTIME_SESSION_ID: identity.runtimeSessionId, CE_PLUGIN_STATUS_ENDPOINT_ID: identity.endpointId }) },
      timeout: probe.timeoutMs,
      maxBuffer: 4096,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        const candidate = error as NodeJS.ErrnoException & { killed?: boolean };
        const code = candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "PROBE_OUTPUT_LIMIT"
          : candidate.killed === true ? "PROBE_TIMEOUT" : "PROBE_EXIT_NONZERO";
        resolve({ state: "UNKNOWN", code });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
            Reflect.ownKeys(parsed).length !== 2 || !("state" in parsed) || !("code" in parsed)) throw new Error();
        const state = (parsed as { state?: unknown }).state;
        const code = (parsed as { code?: unknown }).code;
        if ((state !== "READY" && state !== "DEGRADED" && state !== "UNKNOWN") ||
            typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new Error();
        resolve({ state, code });
      } catch {
        resolve({ state: "UNKNOWN", code: "PROBE_OUTPUT_INVALID" });
      }
    });
  });

export async function runHookStatusProbes(rules: readonly CeHookRule[], identity?: CeHookStatusIdentity): Promise<readonly CeHookStatusResult[]> {
  const providers = rules.filter((rule): rule is CeHookRule & { readonly status: CeHookStatusProbe } => rule.enabled && rule.status !== undefined);
  const results = await Promise.all(providers.map(async (rule) => Object.freeze({
    hookId: rule.id,
    label: rule.status.label,
    scope: rule.scope,
    ...await output(rule.status, identity),
  })));
  return Object.freeze(results);
}
