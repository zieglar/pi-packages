import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelDecision } from "../policy/model-policy.js";
import {
  augmentAdvisorFailureDiagnostic, observeAdvisorResponse, observePreparedTokens,
  type AdvisorPreparedTokenObservation,
} from "../trace/advisor-diagnostics.js";
import type { ExecutionResult } from "../types/result.js";
import { failure, normalizeError } from "../types/result.js";
import type {
  MainSessionModelPort,
  NestedModelOutput,
  NestedModelRequest,
  NestedModelRuntimePort,
} from "./ports.js";

/**
 * The only module aware of Pi extension APIs. Parent model mutation delegates
 * to `ExtensionAPI.setModel`; this file owns the sole production model-mutation callsite.
 * `ExtensionContext.modelRegistry.streamSimple`; model lookup delegates to
 * the same parent model registry. No low-level `pi-ai/compat` transport is
 * imported.
 */
export class PiCompatibilityAdapter implements MainSessionModelPort, NestedModelRuntimePort {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
  ) {}

  async applyModelDecision(
    decision: ModelDecision,
  ): Promise<ExecutionResult<{ provider: string; modelId: string }>> {
    const model = this.ctx.modelRegistry.find(decision.provider, decision.modelId);
    if (!model) {
      return failure({
        kind: "provider",
        scope: "provider",
        confidence: "certain",
        code: "model_not_found",
        message: `model ${decision.provider}/${decision.modelId} is not registered`,
      });
    }
    let applied: boolean;
    try {
      applied = await this.pi.setModel(model);
    } catch (error) {
      return failure(normalizeError(error));
    }
    if (!applied) {
      return failure({
        kind: "authentication",
        scope: "account",
        confidence: "certain",
        code: "model_auth_not_configured",
        message: `authentication is not configured for ${decision.provider}`,
      });
    }
    return { ok: true, value: { provider: decision.provider, modelId: decision.modelId } };
  }

  async stream(request: NestedModelRequest): Promise<ExecutionResult<NestedModelOutput>> {
    const model = this.ctx.modelRegistry.find(request.provider, request.modelId);
    if (!model) {
      // Diagnostic side channel only: the stream was never attempted.
      return failure(augmentAdvisorFailureDiagnostic({
        kind: "provider",
        scope: "provider",
        confidence: "certain",
        code: "model_not_found",
        message: `model ${request.provider}/${request.modelId} is not registered`,
      }, () => ({
        stream: "unavailable",
        reasoning: request.thinking,
        logicalBudget: request.budgetLimit,
      })));
    }
    const context = {
      messages: [
        {
          role: "user" as const,
          content: request.prompt,
          timestamp: 0,
        },
      ],
    };
    let prepared: AdvisorPreparedTokenObservation | undefined;
    try {
      const events = this.ctx.modelRegistry.streamSimple(model, context, {
        reasoning: request.thinking,
        maxTokens: request.budgetLimit,
        onPayload: (payload) => {
          try {
            prepared = observePreparedTokens(payload);
          } catch {
            prepared = undefined;
          }
          // Supported Pi hook: undefined keeps the provider payload unchanged.
          return undefined;
        },
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      const message = await events.result();
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
      const observed = observeAdvisorResponse(() => ({
        content: message.content, stopReason: message.stopReason,
        request: { sdkMaxTokens: request.budgetLimit, ...prepared },
      }));
      return {
        ok: true,
        value: {
          text,
          usage: { inputTokens: message.usage.input, outputTokens: message.usage.output },
          ...(observed !== undefined ? { observed } : {}),
        },
      };
    } catch (error) {
      // Diagnostic side channel only: record what the request attempted
      // without any provider error detail; control semantics are unchanged.
      return failure(augmentAdvisorFailureDiagnostic(normalizeError(error), () => ({
        stream: "rejected",
        reasoning: request.thinking,
        logicalBudget: request.budgetLimit,
        sdkMaxTokens: request.budgetLimit,
        ...prepared,
      })));
    }
  }
}
