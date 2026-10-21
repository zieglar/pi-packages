// gate-fixture: mcp-imports-pi @role control/mcp
// Deliberate violation: the MCP adapter must never reach the Pi adapter.
// @ts-expect-error virtual-role fixture: gate resolves this import from src/control/mcp
import { PI_ADAPTER_KIND } from "../../endpoints/pi/contract.js";

export const violatesSeparation = PI_ADAPTER_KIND;
