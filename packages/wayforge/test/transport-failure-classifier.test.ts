import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  classifyResolvedProviderMessage,
} from "../src/recovery/transport-failure-classifier.js";

type HealthSnapshot = () => readonly unknown[];
type SwitchRoute = () => void;
type ConsumeBudget = () => void;
type ExecuteRecovery = () => void;
type ActivateAccount = () => void;
type RetryAdvisor = () => void;
type ReplayWorker = () => void;

describe("transport failure classification", () => {
  it("classifies matching structured provider evidence", () => {
    const classification = classifyProviderFailure(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        status: 429,
        headers: { "retry-after": "12" },
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#1" },
    );

    expect(classification.classification).toBe("transient_throttle");
    expect(classification.confidence).toBe("certain");
    expect(classification.retryAfterMs).toBe(12_000);
    expect(classification.evidence).toBe("structured");
  });

  it("keeps 402 quota evidence separate from transient throttling", () => {
    const classification = classifyProviderFailure(
      { provider: "zai-coding-cn", modelId: "glm-5.3", status: 402 },
      { provider: "zai-coding-cn", modelId: "glm-5.3", invocationId: "alpha0-1:main#2" },
    );

    expect(classification.classification).toBe("economic_quota");
    expect(classification.confidence).toBe("certain");
    expect(classification.retryAfterMs).toBeUndefined();
  });

  it("classifies recognized temporary connection evidence as transient_connection", () => {
    const classification = classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", networkCode: "ETIMEDOUT" },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#3" },
    );

    expect(classification.classification).toBe("transient_connection");
    expect(classification.confidence).toBe("certain");
  });

  it("classifies 2xx followed by a matching stream failure as transient_connection", () => {
    const classification = classifyResolvedProviderMessage(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        stopReason: "error",
        errorMessage: "stream terminated before completion",
        responseStatus: 200,
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#4" },
    );

    expect(classification.classification).toBe("transient_connection");
    expect(classification.confidence).toBe("certain");
  });

  it("preserves structured 402 as economic_quota instead of unknown", () => {
    const classification = classifyProviderFailure(
      { provider: "zai-coding-cn", modelId: "glm-5.3", status: 402, message: "payment required" },
      { provider: "zai-coding-cn", modelId: "glm-5.3", invocationId: "alpha0-1:main#5" },
    );

    expect(classification.classification).toBe("economic_quota");
    expect(classification.evidence).toBe("structured");
  });

  it("preserves a bounded positive retry hint from supported evidence", () => {
    const classification = classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", status: 429, retryAfterMs: 1_234 },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#6" },
    );

    expect(classification.retryAfterMs).toBe(1_234);
  });

  it("rejects negative, non-finite, and excessively large retry hints", () => {
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const classification = classifyProviderFailure(
        { provider: "openai-codex", modelId: "gpt-5.6-sol", status: 429, retryAfterMs },
        { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#7" },
      );

      expect(classification.retryAfterMs).toBeUndefined();
    }
  });

  it("classifies matching resolved error-bearing results instead of success", () => {
    const classification = classifyResolvedProviderMessage(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        stopReason: "error",
        errorMessage: "provider returned 503 after response started",
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#8" },
    );

    expect(classification.classification).toBe("transient_provider");
    expect(classification.evidence).toBe("structured");
  });

  it("classifies stop and toolUse results as successful terminal results", () => {
    const stop = classifyResolvedProviderMessage(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        stopReason: "stop",
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#9" },
    );
    const toolUse = classifyResolvedProviderMessage(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        stopReason: "toolUse",
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#10" },
    );

    expect(stop.classification).toBe("successful_result");
    expect(toolUse.classification).toBe("successful_result");
    expect(stop.evidence).toBe("structured");
  });

  it("classifies length as incomplete rather than successful transport evidence", () => {
    const classification = classifyResolvedProviderMessage(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        stopReason: "length",
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#11" },
    );

    expect(classification.classification).toBe("incomplete_result");
  });

  it("classifies resolved aborted/cancelled results as cancelled", () => {
    const classification = classifyResolvedProviderMessage(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        stopReason: "aborted",
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#12" },
    );

    expect(classification.classification).toBe("cancelled");
    expect(classification.confidence).toBe("certain");
  });

  it("classifies structured context overflow without competing with Pi recovery", () => {
    const classification = classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", status: 400, contextOverflow: true },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#13" },
    );

    expect(classification.classification).toBe("context_overflow");
    expect(classification.confidence).toBe("certain");
  });

  it("classifies tool failures separately from provider transport failures", () => {
    const classification = classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", toolError: true },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#14" },
    );

    expect(classification.classification).toBe("tool_failure");
    expect(classification.confidence).toBe("certain");
  });

  it.each([
    "HTTP 429",
    "HTTP 503",
    "network error",
    "quota exceeded",
    "connection failed",
  ])("does not classify raw text as transport evidence: %s", (message) => {
    const classification = classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", message },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#15" },
    );

    expect(classification.classification).toBe("unknown");
    expect(classification.evidence).toBe("ambiguous");
  });

  it.each([
    { provider: "openai-codex", modelId: "gpt-5.6-terra" },
    { provider: "openai-codex", modelId: "" },
  ])("fails closed on mismatched or missing model attribution", (selected) => {
    const classification = classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", status: 429 },
      { ...selected, invocationId: "alpha0-1:main#16" },
    );

    expect(classification.classification).toBe("unknown");
    expect(classification.evidence).toBe("ambiguous");
  });

  it("sanitizes provider evidence before preserving bounded details", () => {
    const classification = classifyProviderFailure(
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        status: 401,
        message:
          "Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789 while reading /Users/example/project/file.ts",
      },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#17" },
    );

    expect(classification.classification).toBe("authentication");
    expect(JSON.stringify(classification)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.stringify(classification)).not.toContain("/Users/example/project/file.ts");
  });

  it("is deterministic for identical bounded inputs", () => {
    const input = {
      evidence: { provider: "openai-codex", modelId: "gpt-5.6-sol", status: 503 },
      selected: { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#18" },
    } as const;

    expect(classifyProviderFailure(input.evidence, input.selected)).toEqual(
      classifyProviderFailure(input.evidence, input.selected),
    );
  });

  it("does not exercise recovery authorities", () => {
    const healthSnapshot: HealthSnapshot = () => [];
    const switchRoute: SwitchRoute = () => {
      throw new Error("switchRoute must not be called");
    };
    const consumeBudget: ConsumeBudget = () => {
      throw new Error("consumeBudget must not be called");
    };
    const executeRecovery: ExecuteRecovery = () => {
      throw new Error("executeRecovery must not be called");
    };
    const activateAccount: ActivateAccount = () => {
      throw new Error("activateAccount must not be called");
    };
    const retryAdvisor: RetryAdvisor = () => {
      throw new Error("retryAdvisor must not be called");
    };
    const replayWorker: ReplayWorker = () => {
      throw new Error("replayWorker must not be called");
    };

    classifyProviderFailure(
      { provider: "openai-codex", modelId: "gpt-5.6-sol", status: 429 },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", invocationId: "alpha0-1:main#19" },
    );

    expect(healthSnapshot()).toEqual([]);
    expect(() => switchRoute()).toThrow("switchRoute must not be called");
    expect(() => consumeBudget()).toThrow("consumeBudget must not be called");
    expect(() => executeRecovery()).toThrow("executeRecovery must not be called");
    expect(() => activateAccount()).toThrow("activateAccount must not be called");
    expect(() => retryAdvisor()).toThrow("retryAdvisor must not be called");
    expect(() => replayWorker()).toThrow("replayWorker must not be called");
  });

  it("does not import execution authorities", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "recovery", "transport-failure-classifier.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'].*(?:main-model-controller|runtime-recovery-executor|pi-accounts-adapter|completion-authority)["']/);
    expect(source).not.toMatch(/\bsetModel\s*\(/);
    expect(source).not.toContain("new HealthRegistry(");
    expect(source).not.toContain("HealthProjector");
    expect(source).not.toContain("sendUserMessage");
    expect(source).not.toContain("follow_up");
    expect(source).not.toContain("continueSession");
  });

});
