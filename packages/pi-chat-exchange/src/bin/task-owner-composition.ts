import type { CeBoundEndpoint } from "../host/bound-endpoint.js";
import type { CeEndpointHost } from "../host/endpoint-host.js";
import type { McpBindingConfig } from "../host/mcp-binding-config.js";
import type { createLiveMcpComposition } from "../tunnel/live-mcp-composition.js";
import { createTaskOwnerRegistryPort, loadTaskOwnershipSidecar } from "../control/mcp/task-owner-registry.js";
import type { TaskOwnerPort } from "../control/mcp/task-owner.js";

const INVALID = "CE_MCP_TASK_OWNERSHIP_INVALID";
const DENIED = "CE_MCP_TASK_OWNERSHIP_DENIED";

type LiveComposition = ReturnType<typeof createLiveMcpComposition>;

export interface TaskOwnerComposition {
  readonly taskOwner: TaskOwnerPort;
  readonly taskOwnerAdmission: () => void;
}

/** Compose TaskOwner only from a private sidecar and the current live Session.
 * Runtime selection, endpoint binding and delivery outcomes grant no ownership. */
export function createTaskOwnerComposition(
  configPath: string,
  config: McpBindingConfig,
  live: LiveComposition | undefined,
  host: CeEndpointHost,
  bound: CeBoundEndpoint,
): TaskOwnerComposition | undefined {
  const sidecar = loadTaskOwnershipSidecar(configPath);
  if (sidecar === undefined) return undefined;
  if (live === undefined) throw new Error(INVALID);

  const loaded = live.snapshot();
  const activePi = loaded.manifest.registrations.filter(registration => registration.status === "active" &&
    config.recipients.some(recipient => recipient.adapter === "pi" && recipient.endpointId === registration.endpointId));
  const selected = sidecar.piEndpoint === undefined
    ? activePi.length === 1 ? activePi[0] : undefined
    : activePi.find(registration => registration.endpointId === sidecar.piEndpoint);
  if (selected === undefined || (sidecar.piEndpoint === undefined && activePi.length !== 1)) throw new Error(INVALID);

  const initial = host.status(config.endpoint.endpointId);
  if (initial.lease !== "ACTIVE" || initial.exchangeId === undefined) throw new Error(INVALID);
  const scope = Object.freeze({ exchangeId: initial.exchangeId, from: selected.endpointId, to: config.endpoint.endpointId });
  const taskOwner = createTaskOwnerRegistryPort(sidecar.registryDirectory, scope);

  const taskOwnerAdmission = (): void => {
    const operational = bound.operationalStatus();
    const status = host.status(config.endpoint.endpointId);
    if (operational.state !== "ACTIVE" || operational.renewal !== "RUNNING" || status.lease !== "ACTIVE" ||
      status.exchangeId !== scope.exchangeId) throw new Error(DENIED);
    const prepared = live.recipients.snapshot();
    const current = live.snapshot();
    if (!prepared.recipients.some(recipient => recipient.adapter === "pi" && recipient.endpointId === scope.from) ||
      !current.manifest.registrations.some(registration => registration.endpointId === scope.from &&
        registration.runtimeSessionId === selected.runtimeSessionId && registration.epoch === selected.epoch && registration.status === "active")) {
      throw new Error(DENIED);
    }
    try { live.admission({ kind: "inbox" }, prepared); }
    catch { throw new Error(DENIED); }
  };

  return Object.freeze({ taskOwner, taskOwnerAdmission });
}
