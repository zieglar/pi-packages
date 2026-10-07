export interface TransportEndpoint {
  readonly provider: string;
  readonly modelId: string;
}

/** Exact opaque endpoint identity for one immutable runtime policy snapshot. */
export function transportEndpointKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}
