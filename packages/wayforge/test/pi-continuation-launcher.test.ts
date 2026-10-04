import { describe, expect, it, vi } from "vitest";
import { PiContinuationLauncher, type PiContinuationSessionFactory } from "../src/runtime/pi-continuation-launcher.js";
import { buildContinuationPackage } from "../src/recovery/continuation.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

const workspace = populatedTaskState().workspace!;

describe("PiContinuationLauncher", () => {
  it("creates a fresh Pi session and submits only the deterministic continuation package", async () => {
    const prompt = vi.fn(async (_text: string) => undefined);
    const create = vi.fn<PiContinuationSessionFactory["create"]>(async () => ({ sessionId: "pi-new-session", prompt }));
    const launcher = new PiContinuationLauncher({ factory: { create } });
    const packageData = buildContinuationPackage({
      state: populatedTaskState({ continuation: null }),
      workspace,
      continuationId: "task-fixture:resume-1",
    });

    const result = await launcher.launch(packageData, "task-fixture:resume-1");
    expect(result).toMatchObject({ ok: true, value: { invocationId: "task-fixture:resume-1", sessionId: "pi-new-session" } });
    expect(create).toHaveBeenCalledWith({ continuationId: "task-fixture:resume-1" });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0]).toContain("new invocation");
    expect(prompt.mock.calls[0]?.[0]).not.toContain("sk-fixturesecret");
  });

  it("rejects a mismatched launch identity before creating any Pi session", async () => {
    const create = vi.fn<PiContinuationSessionFactory["create"]>();
    const launcher = new PiContinuationLauncher({ factory: { create } });
    const packageData = buildContinuationPackage({ state: populatedTaskState(), workspace, continuationId: "expected" });

    const result = await launcher.launch(packageData, "different");
    expect(result).toMatchObject({ ok: false, failure: { code: "continuation_identity_mismatch" } });
    expect(create).not.toHaveBeenCalled();
  });
});
