/** Trusted launch-only environment boundary. MCP control and composition stay
 * environment-free; the returned digest is still matched to the exact launch. */
export function sourceMetadataProbeLaunchDigest(): string | undefined {
  return process.env.CE_SOURCE_METADATA_PROBE_LAUNCH_DIGEST;
}
