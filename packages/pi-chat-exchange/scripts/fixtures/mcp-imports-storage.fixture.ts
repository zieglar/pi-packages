// gate-fixture: mcp-imports-storage @role control/mcp
// Deliberate violation: the MCP control surface must never reach storage or
// the host; all composition belongs in bin.
// @ts-expect-error virtual-role fixture: gate resolves this import from src/control/mcp
import { openStore } from "../../storage/store.js";

export const violatesSeparation = openStore;
