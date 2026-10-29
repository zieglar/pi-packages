import { CANDIDATE_NODE_RANGE, MINIMUM_SQLITE_VERSION, PI_HOST_MINIMUM_NODE_VERSION, assertHostRuntimeEligibility } from "../storage/runtime.js";
import { ExecutableRefusal, diagnoseTunnelClient, resolveApprovedNode, type ExecutableResolutionOptions, type TunnelClientDiagnosis } from "./executables.js";

export interface InstallationDiagnosis {
  readonly host: "QUALIFIED" | "STORAGE_RUNTIME_INELIGIBLE";
  readonly child: "QUALIFIED" | "CE_NODE_UNAVAILABLE" | "CE_NODE_INELIGIBLE" | "CE_EXECUTABLE_UNTRUSTED";
  readonly client: TunnelClientDiagnosis;
}

/** No profile, credential, Store or transport access. Host uses the actual
 * in-memory SQLite/API battery; only an admitted Node child is executed. */
export function diagnoseInstallation(options: ExecutableResolutionOptions = {}): InstallationDiagnosis {
  let host: InstallationDiagnosis["host"] = "QUALIFIED";
  try { assertHostRuntimeEligibility(); } catch { host = "STORAGE_RUNTIME_INELIGIBLE"; }
  let child: InstallationDiagnosis["child"];
  try { child = resolveApprovedNode(options) === undefined ? "CE_NODE_UNAVAILABLE" : "QUALIFIED"; }
  catch (error) { child = error instanceof ExecutableRefusal ? error.code : "CE_NODE_INELIGIBLE"; }
  return { host, child, client: diagnoseTunnelClient(options) };
}

export function installationDiagnosticMessage(result: InstallationDiagnosis): string {
  return `ce-tunnel doctor: Pi host=${result.host} (in-memory SQLite/runtime check); MCP child=${result.child}; client=${result.client}. ` +
    "Client trust is metadata only, not compatibility or connectivity. No client executed; no profile/Store/transport changes. " +
    "For a missing client, install separately; for rejected trust, repair the private installation and its ancestors/ACLs or select a trusted absolute CE_TUNNEL_CLIENT_PATH outside projects. Never use PATH fallback or relax trust. " +
    "Select an independently qualified MCP child with CE_NODE_PATH. " + hostRuntimeRepairMessage() +
    ". Installation checks are not transport, delivery, ACK or completion evidence.";
}

/** No raw subprocess output, paths, configuration values or exception causes. */
export function hostRuntimeRepairMessage(nodeVersion: string = process.version): string {
  const current = /^v\d+\.\d+\.\d+$/.test(nodeVersion) ? nodeVersion : "unrecognized";
  return `current Pi Node ${current}; Native requires Pi Host Node >=${PI_HOST_MINIMUM_NODE_VERSION}, Node-API >=8 and a verified Native cache with SQLite >=${MINIMUM_SQLITE_VERSION} and proven capabilities. Native trust/load failure is closed, with no fallback; prepare requires separately verified pins. Explicit non-production node-sqlite retains candidate Node >=${CANDIDATE_NODE_RANGE.minimum} within majors 24/25/26 and its known-defect refusals; restart Pi using a trusted absolute approved Node executable. CE_NODE_PATH selects the MCP child only, not the running Pi host; each qualifies independently and need not use the same executable; mise is not required`;
}
