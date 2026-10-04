import type { CapabilityCatalog } from "../kernel/capability-catalog.js";
import type { CapabilityDescriptor } from "../kernel/capability-catalog.js";
import type { ExecutionRequirement } from "./role-policy.js";
import type { CapabilityId, RouteId } from "../types/identity.js";
import type { InvocationRole, ModelTier, ThinkingLevel } from "../types/execution.js";

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
    };

export type ModelResolution =
  | { readonly ok: true; readonly decision: ModelDecision }
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
    this.routes = [...routes];
  }

  resolve(
    requirement: ExecutionRequirement,
    catalog: typeof CapabilityCatalog,
  ): ModelResolution {
    const route = this.routes.find((r) => r.capabilityId === requirement.capabilityId);
    if (!route) {
      return {
        ok: false,
        failure: { kind: "no_route", capabilityId: requirement.capabilityId },
      };
    }
    const cap = catalog.get(route.capabilityId);
    if (!cap) {
      return {
        ok: false,
        failure: {
          kind: "capability_mismatch",
          routeId: route.routeId,
          reason: "route capability missing from catalog",
        },
      };
    }
    const check = satisfies(cap, route, requirement);
    if (!check.ok) {
      return {
        ok: false,
        failure: { kind: "capability_mismatch", routeId: route.routeId, reason: check.reason },
      };
    }
    return {
      ok: true,
      decision: {
        routeId: route.routeId,
        provider: route.provider,
        modelId: route.modelId,
        tier: route.tier,
        thinking: route.thinking,
        capabilityId: route.capabilityId,
        budget: { limit: route.budgetLimit },
      },
    };
  }
}
