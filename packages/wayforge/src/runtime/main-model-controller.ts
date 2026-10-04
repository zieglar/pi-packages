import type { ModelDecision } from "../policy/model-policy.js";
import type { InvocationRole } from "../types/execution.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { failure } from "../types/result.js";
import type { MainSessionModelPort } from "./ports.js";

/**
 * Sole Wayforge component authorized to request a parent session model
 * change. It validates the role and delegates an already-resolved decision to
 * a `MainSessionModelPort`; it never resolves policy itself.
 */
export class MainModelController {
  constructor(private readonly port: MainSessionModelPort) {}

  async applyModelDecision(input: {
    role: InvocationRole;
    decision: ModelDecision;
  }): Promise<ExecutionResult<{ provider: string; modelId: string }>> {
    if (input.role !== "main") {
      return failure(
        MainModelController.nonMainRoleFailure(input.role),
      );
    }
    return this.port.applyModelDecision(input.decision);
  }

  static nonMainRoleFailure(role: InvocationRole): Failure {
    return {
      kind: "capability",
      scope: "invocation",
      confidence: "certain",
      code: "non_main_role",
      message: `parent session model changes are reserved for the main role (got "${role}")`,
    };
  }
}
