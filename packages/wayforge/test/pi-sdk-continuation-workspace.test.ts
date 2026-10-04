import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  inMemory: vi.fn((cwd: string) => ({ cwd, getSessionId: () => "new-sdk-session" })),
  createAgentSession: vi.fn(async (_options: unknown) => ({ session: { prompt: vi.fn(async () => undefined) } })),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { inMemory: sdk.inMemory },
  createAgentSession: sdk.createAgentSession,
}));
import { PiSdkContinuationSessionFactory } from "../src/runtime/pi-continuation-launcher.js";

describe("SDK continuation workspace binding", () => {
  it("uses the verified task workspace rather than the restarting session workspace", async () => {
    const factory = new PiSdkContinuationSessionFactory({ cwd: "/restart-workspace", agentDir: "/isolated-agent" });
    const input = { continuationId: "task:resume-1", cwd: "/verified-task-workspace" };
    await factory.create(input);
    expect(sdk.inMemory).toHaveBeenCalledWith("/verified-task-workspace");
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/verified-task-workspace",
      agentDir: "/isolated-agent",
    }));
  });
});
