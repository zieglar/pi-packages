import type { ModelDecision } from "../policy/model-policy.js";
import type { HealthRegistry } from "./health-registry.js";
import {
  transportEndpointKey,
  type TransportEndpoint,
} from "../types/transport-route.js";

export { transportEndpointKey } from "../types/transport-route.js";

export interface MainRouteEligibilityInput {
  readonly candidates: readonly ModelDecision[];
  readonly currentEndpoint: TransportEndpoint;
  readonly visitedEndpoints: ReadonlySet<string>;
}

export interface MainRouteEligibilitySnapshot extends MainRouteEligibilityInput {
  readonly routeAvailability: ReadonlyMap<string, boolean>;
}

/** Pure projection over one already-captured runtime health snapshot. */
export function projectEligibleMainAlternatives(
  input: MainRouteEligibilitySnapshot,
): readonly ModelDecision[] {
  const currentKey = transportEndpointKey(input.currentEndpoint.provider, input.currentEndpoint.modelId);
  const emittedEndpoints = new Set<string>();
  const eligible: ModelDecision[] = [];

  for (const candidate of input.candidates) {
    const endpoint = transportEndpointKey(candidate.provider, candidate.modelId);
    if (endpoint === currentKey || input.visitedEndpoints.has(endpoint)) continue;
    if (input.routeAvailability.get(candidate.routeId) !== true) continue;
    if (emittedEndpoints.has(endpoint)) continue;
    emittedEndpoints.add(endpoint);
    eligible.push(candidate);
  }

  return Object.freeze(eligible);
}

/**
 * Runtime-private read boundary. It captures availability from the workflow's
 * sole HealthRegistry, then delegates to the pure ordered projection.
 */
export class MainRouteEligibility {
  constructor(private readonly health: HealthRegistry) {}

  alternatives(input: MainRouteEligibilityInput): readonly ModelDecision[] {
    const routeAvailability = new Map<string, boolean>();
    for (const candidate of input.candidates) {
      routeAvailability.set(candidate.routeId, this.health.isAvailable(candidate.routeId));
    }
    return projectEligibleMainAlternatives({ ...input, routeAvailability });
  }
}
