// gate-fixture: core-imports-adapter @role core
// Deliberate violation: core must never depend on an adapter.
import { SERVER_NAME } from "../control/mcp/server.js";

export const violatesDirection = SERVER_NAME;
