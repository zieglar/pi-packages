import type {
  AccountAdapter,
  AccountRouteQuery,
  SanitizedRoute,
} from "./contracts.js";
import type { HealthRegistry } from "../recovery/health-registry.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { success } from "../types/result.js";
import type { ExecutionRoute } from "../workflow/contracts.js";

export interface ModelAvailabilityPort {
  hasModel(provider: string, modelId: string): boolean;
}

export type RouteOutcomeReporter = (
  route: ExecutionRoute,
  outcome: Failure | { readonly ok: true },
) => void;

export class PassiveAccountAdapter implements AccountAdapter {
  private readonly routes: readonly ExecutionRoute[];

  constructor(
    routes: readonly ExecutionRoute[],
    private readonly models: ModelAvailabilityPort,
    private readonly health: HealthRegistry,
    private readonly onOutcome?: RouteOutcomeReporter,
  ) {
    this.routes = [...routes].sort((left, right) => left.routeId.localeCompare(right.routeId));
  }

  async listExecutionRoutes(query: AccountRouteQuery): Promise<ExecutionResult<readonly ExecutionRoute[]>> {
    const routes = this.routes.filter((route) => {
      const roleEligible = query.role === "worker" ? route.capabilities.worker : route.capabilities.advisor;
      return roleEligible &&
        this.models.hasModel(route.provider, route.modelId) &&
        this.health.isAvailable(route.routeId) &&
        this.health.isAvailable(route.provider) &&
        this.health.isAvailable(route.modelId) &&
        (route.accountRef === undefined || this.health.isAvailable(route.accountRef));
    });
    return success(routes.map((route) => ({ ...route, capabilities: { ...route.capabilities } })));
  }

  async listEligibleRoutes(query: AccountRouteQuery): Promise<ExecutionResult<readonly SanitizedRoute[]>> {
    const eligible = await this.listExecutionRoutes(query);
    if (!eligible.ok) return eligible;
    return success(eligible.value.map((route) => ({
      routeId: route.routeId,
      provider: route.provider,
      modelId: route.modelId,
      ...(route.accountRef !== undefined ? { accountId: route.accountRef } : {}),
      status: "available" as const,
    })));
  }

  async reportRouteOutcome(
    route: SanitizedRoute,
    outcome: Failure | { readonly ok: true },
  ): Promise<ExecutionResult<void>> {
    const configured = this.routes.find((candidate) => candidate.routeId === route.routeId);
    if (configured !== undefined) this.onOutcome?.(configured, outcome);
    return success(undefined);
  }
}
