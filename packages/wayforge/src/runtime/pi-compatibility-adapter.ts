import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyResolvedProviderMessage,
  type TransportFailureClassification,
} from "../recovery/transport-failure-classifier.js";
import type { ModelDecision } from "../policy/model-policy.js";
import {
  augmentAdvisorFailureDiagnostic, observeAdvisorResponse, observePreparedTokens,
  type AdvisorPreparedTokenObservation,
} from "../trace/advisor-diagnostics.js";
import type { ExecutionResult, Failure } from "../types/result.js";
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
      const terminalStopReason = readMessageString(message, "stopReason") ??
        (readMessageString(message, "errorMessage") !== undefined ? "error" : "stop");
      const classification = classifyResolvedProviderMessage(
        {
          provider: readMessageString(message, "provider") ?? request.provider,
          modelId: readMessageString(message, "model") ?? request.modelId,
          stopReason: terminalStopReason,
          ...(readMessageString(message, "errorMessage") !== undefined
            ? { errorMessage: readMessageString(message, "errorMessage") }
            : {}),
        },
        { provider: request.provider, modelId: request.modelId },
      );
      const nonTransportUnknownStopReason = classification.classification === "unknown" &&
        classification.code === "unsupported_stop_reason";
      if (classification.classification !== "successful_result" && !nonTransportUnknownStopReason) {
        return failure(augmentAdvisorFailureDiagnostic(transportFailureToFailure(classification), () => ({
          stream: "resolved",
          stopReason: terminalStopReason,
          reasoning: request.thinking,
          logicalBudget: request.budgetLimit,
          sdkMaxTokens: request.budgetLimit,
          ...prepared,
        })));
      }
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

function readMessageString(message: unknown, key: string): string | undefined {
  try {
    const value = (message as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function transportFailureToFailure(classification: TransportFailureClassification): Failure {
  const detail = classification.detail === undefined ? "" : `: ${classification.detail}`;
  switch (classification.classification) {
    case "transient_throttle":
      return {
        kind: "rate_limit",
        scope: "provider",
        confidence: classification.confidence,
        code: classification.code,
        message: `provider invocation was throttled${detail}`,
        ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
      };
    case "transient_provider":
      return {
        kind: "provider",
        scope: "provider",
        confidence: classification.confidence,
        code: classification.code,
        message: `provider invocation failed${detail}`,
        ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
      };
    case "transient_connection":
      return {
        kind: "network",
        scope: "provider",
        confidence: classification.confidence,
        code: classification.code,
        message: `provider connection or stream failed${detail}`,
        ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
      };
    case "authentication":
      return {
        kind: "authentication",
        scope: "account",
        confidence: classification.confidence,
        code: classification.code,
        message: `provider authentication failed${detail}`,
      };
    case "economic_quota":
      return {
        kind: "usage_limit",
        scope: "account",
        confidence: classification.confidence,
        code: classification.code,
        message: `provider quota or billing limit was reached${detail}`,
      };
    case "context_overflow":
      return {
        kind: "context_overflow",
        scope: "model",
        confidence: classification.confidence,
        code: classification.code,
        message: "provider context overflow",
      };
    case "cancelled":
      return {
        kind: "cancellation",
        scope: "invocation",
        confidence: classification.confidence,
        code: classification.code,
        message: "provider invocation was cancelled",
      };
    case "tool_failure":
      return {
        kind: "tool",
        scope: "invocation",
        confidence: classification.confidence,
        code: classification.code,
        message: "tool execution failed",
      };
    case "incomplete_result":
      return {
        kind: "validation",
        scope: "invocation",
        confidence: classification.confidence,
        code: classification.code,
        message: "provider returned an incomplete terminal result",
      };
    case "unknown":
    case "successful_result":
      return {
        kind: "unknown",
        scope: "system",
        confidence: "ambiguous",
        code: classification.code,
        message: classification.detail ?? "provider invocation outcome is unknown",
      };
  }
}
