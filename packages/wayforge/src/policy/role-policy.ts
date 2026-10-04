import type { CapabilityId, TaskId } from "../types/identity.js";
import type { InvocationRole } from "../types/execution.js";

/**
 * What a role requires from execution. Produced by RolePolicy; consumed by
 * ModelPolicy. Contains no provider or model facts.
 */
export interface ExecutionRequirement {
  readonly role: InvocationRole;
  readonly taskId: TaskId;
  readonly capabilityId: CapabilityId;
  readonly allowNested: boolean;
  readonly needsStreaming: boolean;
  readonly needsReasoning: boolean;
  readonly needsTools: boolean;
  readonly budgetLimit: number;
}

/** One configured role rule. */
export interface RoleRule {
  readonly role: InvocationRole;
  readonly capabilityId: CapabilityId;
  readonly allowNested: boolean;
  readonly needsStreaming: boolean;
  readonly needsReasoning: boolean;
  readonly needsTools: boolean;
  readonly budgetLimit: number;
}

export type RolePolicyFailure = { readonly kind: "unknown_role"; readonly role: string };

export type RoleResolution =
  | { readonly ok: true; readonly requirement: ExecutionRequirement }
  | { readonly ok: false; readonly failure: RolePolicyFailure };

/**
 * Pure role policy: maps a role plus task identity to an execution
 * requirement. Deterministic, synchronous, no side effects.
 */
export class RolePolicy {
  private readonly rules: ReadonlyMap<string, RoleRule>;

  constructor(rules: readonly RoleRule[]) {
    const map = new Map<string, RoleRule>();
    for (const rule of rules) map.set(rule.role, rule);
    this.rules = map;
  }

  resolve(input: { role: InvocationRole; taskId: TaskId }): RoleResolution {
    const rule = this.rules.get(input.role);
    if (!rule) {
      return { ok: false, failure: { kind: "unknown_role", role: input.role } };
    }
    return {
      ok: true,
      requirement: {
        role: input.role,
        taskId: input.taskId,
        capabilityId: rule.capabilityId,
        allowNested: rule.allowNested,
        needsStreaming: rule.needsStreaming,
        needsReasoning: rule.needsReasoning,
        needsTools: rule.needsTools,
        budgetLimit: rule.budgetLimit,
      },
    };
  }
}
