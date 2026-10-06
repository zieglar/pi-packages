// gate-fixture: mcp-env-access @role control/mcp
// Deliberate violation: the MCP surface must never touch the environment.
export const controlPlaneKey: string | undefined = process.env.CONTROL_PLANE_API_KEY;
