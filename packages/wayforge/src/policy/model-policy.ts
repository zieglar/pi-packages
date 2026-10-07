import type { CapabilityCatalog } from "../kernel/capability-catalog.js";
import type { CapabilityDescriptor } from "../kernel/capability-catalog.js";
import type { ExecutionRequirement } from "./role-policy.js";
import type { CapabilityId, RouteId } from "../types/identity.js";
import type { InvocationRole, ModelTier, ThinkingLevel } from "../types/execution.js";
import { transportEndpointKey } from "../types/transport-route.js";

/** One statically configured model route. */
export interface StaticModelRoute {
  readonly routeId: RouteId;
  readonly provider: string;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly thinking: ThinkingLevel;
  readonly capabilityId: CapabilityId;
  readonly budgetLimit: number;
}

/** Fully resolved model choice for one execution requirement. */
export interface ModelDecision {
  readonly routeId: RouteId;
  readonly provider: string;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly thinking: ThinkingLevel;
  readonly capabilityId: CapabilityId;
  readonly budget: { readonly limit: number };
}

export type ModelPolicyFailure =
  | { readonly kind: "no_route"; readonly capabilityId: CapabilityId }
  | {
      readonly kind: "capability_mismatch";
      readonly routeId: RouteId;
      readonly reason: string;
    }
  | {
      readonly kind: "duplicate_endpoint";
      readonly provider: string;
      readonly modelId: string;
      readonly routeIds: readonly [RouteId, RouteId];
    };

export type ModelResolution =
  | { readonly ok: true; readonly decision: ModelDecision }
  | { readonly ok: false; readonly failure: ModelPolicyFailure };

export type ModelCandidatesResolution =
  | { readonly ok: true; readonly candidates: readonly ModelDecision[] }
  | { readonly ok: false; readonly failure: ModelPolicyFailure };

function satisfies(
  cap: CapabilityDescriptor,
  route: StaticModelRoute,
  requirement: ExecutionRequirement,
): { ok: true } | { ok: false; reason: string } {
  if (requirement.needsStreaming && !cap.streaming) {
    return { ok: false, reason: "route capability lacks streaming" };
  }
  if (requirement.needsReasoning && !cap.reasoning) {
    return { ok: false, reason: "route capability lacks reasoning" };
  }
  if (requirement.needsTools && !cap.tools) {
    return { ok: false, reason: "route capability lacks tools" };
  }
  if (requirement.allowNested && !cap.allowNestedInvocation) {
    return { ok: false, reason: "route capability forbids nested invocation" };
  }
  if (requirement.role === "worker" && !cap.workerEligible) {
    return { ok: false, reason: "route capability is not worker eligible" };
  }
  if (requirement.role === "advisor" && !cap.advisorEligible) {
    return { ok: false, reason: "route capability is not advisor eligible" };
  }
  if (cap.allowedProviders && !cap.allowedProviders.includes(route.provider)) {
    return { ok: false, reason: `provider ${route.provider} not permitted for capability` };
  }
  if (cap.allowedModels && !cap.allowedModels.includes(route.modelId)) {
    return { ok: false, reason: `model ${route.modelId} not permitted for capability` };
  }
  return { ok: true };
}

/**
 * Pure model policy: resolves an execution requirement against static routes
 * and capability facts. Deterministic first-match; no provider calls, no
 * adaptive routing, no session mutation.
 */
export class ModelPolicy {
  private readonly routes: readonly StaticModelRoute[];

  constructor(routes: readonly StaticModelRoute[]) {
    const seenRouteIds = new Set<RouteId>();
    for (const route of routes) {
      if (seenRouteIds.has(route.routeId)) {
        throw new Error(`duplicate route id: ${route.routeId}`);
      }
      seenRouteIds.add(route.routeId);
    }
    this.routes = Object.freeze(routes.map((route) => Object.freeze({ ...route })));
  }

  candidates(
    requirement: ExecutionRequirement,
    catalog: typeof CapabilityCatalog,
  ): ModelCandidatesResolution {
    const matching = this.routes.filter((route) => route.capabilityId === requirement.capabilityId);
    if (matching.length === 0) return { ok: true, candidates: [] };

    const cap = catalog.get(requirement.capabilityId);
    if (!cap) {
      return {
        ok: false,
        failure: {
          kind: "capability_mismatch",
          routeId: matching[0]!.routeId,
          reason: "route capability missing from catalog",
        },
      };
    }

    const candidates: ModelDecision[] = [];
    let firstMismatch: { readonly routeId: RouteId; readonly reason: string } | undefined;
    for (const route of matching) {
      const check = satisfies(cap, route, requirement);
      if (!check.ok) {
        firstMismatch ??= { routeId: route.routeId, reason: check.reason };
        continue;
      }
      candidates.push(Object.freeze({
        routeId: route.routeId,
        provider: route.provider,
        modelId: route.modelId,
        tier: route.tier,
        thinking: route.thinking,
        capabilityId: route.capabilityId,
        budget: Object.freeze({ limit: route.budgetLimit }),
      }));
    }

    if (candidates.length === 0 && firstMismatch !== undefined) {
      return {
        ok: false,
        failure: {
          kind: "capability_mismatch",
          routeId: firstMismatch.routeId,
          reason: firstMismatch.reason,
        },
      };
    }

    if (requirement.role === "main") {
      const endpoints = new Map<string, ModelDecision>();
      for (const candidate of candidates) {
        const key = transportEndpointKey(candidate.provider, candidate.modelId);
        const duplicate = endpoints.get(key);
        if (duplicate !== undefined) {
          return {
            ok: false,
            failure: {
              kind: "duplicate_endpoint",
              provider: candidate.provider,
              modelId: candidate.modelId,
              routeIds: [duplicate.routeId, candidate.routeId],
            },
          };
        }
        endpoints.set(key, candidate);
      }
    }

    return { ok: true, candidates: Object.freeze(candidates) };
  }

  resolve(
    requirement: ExecutionRequirement,
    catalog: typeof CapabilityCatalog,
  ): ModelResolution {
    const candidates = this.candidates(requirement, catalog);
    if (!candidates.ok) return candidates;
    const decision = candidates.candidates[0];
    if (decision === undefined) {
      return {
        ok: false,
        failure: { kind: "no_route", capabilityId: requirement.capabilityId },
      };
    }
    return { ok: true, decision };
  }
}
