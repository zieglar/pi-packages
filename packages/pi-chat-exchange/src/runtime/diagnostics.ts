import { APPROVED_RUNTIME_TUPLES } from "../storage/runtime.js";

/** No raw subprocess output, paths, configuration values or exception causes. */
export function hostRuntimeRepairMessage(nodeVersion: string = process.version): string {
  const current = /^v\d+\.\d+\.\d+$/.test(nodeVersion) ? nodeVersion : "unrecognized";
  return `current Pi Node ${current}; requires approved Node ${APPROVED_RUNTIME_TUPLES.map(({ nodeVersion: version }) => version).join(" or ")} with approved SQLite; restart Pi using a trusted absolute approved Node executable. CE_NODE_PATH selects the MCP child only, not the running Pi host; each qualifies independently and need not use the same executable; mise is not required`;
}
