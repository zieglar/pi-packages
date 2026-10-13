// gate-fixture: host-imports-control @role host
// Deliberate violation: the host authority layer must never reach control.
// @ts-expect-error virtual-role fixture: gate resolves this import from src/host
import { SERVER_NAME } from "../control/mcp/server.js";

export const violatesSeparation = SERVER_NAME;
