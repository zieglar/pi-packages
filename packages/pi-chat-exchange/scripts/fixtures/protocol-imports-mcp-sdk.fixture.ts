// gate-fixture: protocol-imports-mcp-sdk @role protocol
// Deliberate violation: protocol must stay transport/adapter neutral.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export const violatesNeutrality = Server;
