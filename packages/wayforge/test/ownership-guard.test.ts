import { describe, expect, it } from "vitest";
import {
  checkOwnershipGuard,
  type GuardCommandRecord,
  type GuardToolRecord,
} from "../src/runtime/ownership-guard.js";

const builtin = (name: string): GuardToolRecord => ({
  name,
  sourceInfo: { source: "builtin", path: `builtin:${name}` },
});

const wayforge = (name: string): GuardToolRecord => ({
  name,
  sourceInfo: { source: "wayforge", path: "/Users/x/Code/wayforge/dist/extension.js" },
});

const external = (name: string, source: string): GuardToolRecord => ({
  name,
  sourceInfo: { source, path: `/pi/extensions/${source}/index.js` },
});

describe("checkOwnershipGuard", () => {
  it("allows builtin tools, Wayforge tools, and the pi-subagents worker engine", () => {
    const result = checkOwnershipGuard({
      tools: [
        builtin("read"),
        builtin("bash"),
        wayforge("wayforge_task_status"),
        external("subagent", "pi-subagents"),
      ],
      commands: [
        { name: "wayforge", sourceInfo: { source: "wayforge", path: "/Users/x/Code/wayforge/dist/extension.js" } },
        { name: "help", sourceInfo: { source: "builtin", path: "builtin:help" } },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails closed on active shift-router, multi-account, or advisor-flow sources", () => {
    for (const competing of ["pi-shift-router", "pi-multi-account", "pi-advisor-flow"]) {
      const result = checkOwnershipGuard({
        tools: [builtin("read"), external("route_model", competing)],
        commands: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain(competing);
        expect(result.failures[0]).toContain("route_model");
        expect(result.failures[0]).toContain("fails closed");
      }
    }
  });

  it("rejects reserved Wayforge tool names and the /wayforge command from foreign sources", () => {
    const tools = checkOwnershipGuard({
      tools: [external("wayforge_delegate_workers", "some-other-extension")],
      commands: [],
    });
    expect(tools.ok).toBe(false);
    if (!tools.ok) expect(tools.failures[0]).toContain("wayforge_delegate_workers");
    const commands = checkOwnershipGuard({
      tools: [],
      commands: [{ name: "wayforge", sourceInfo: { source: "foreign" } }],
    });
    expect(commands.ok).toBe(false);
    if (!commands.ok) expect(commands.failures[0]).toContain("/wayforge");
  });

  it("reports competing commands separately from tools", () => {
    const result = checkOwnershipGuard({
      tools: [],
      commands: [
        {
          name: "accounts",
          sourceInfo: { source: "pi-multi-account", path: "/pi/extensions/pi-multi-account/index.js" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]).toContain("/accounts");
  });
});
