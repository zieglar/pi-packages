// gate-fixture: mcp-imports-pi @role adapters/mcp
// Deliberate violation: the MCP adapter must never reach the Pi adapter.
import { PI_ADAPTER_KIND } from "../pi/contract.js";

export const violatesSeparation = PI_ADAPTER_KIND;
