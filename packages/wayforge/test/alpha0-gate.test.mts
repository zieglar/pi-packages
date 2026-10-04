import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const GATE = "scripts/check-alpha0.mjs";

function runGate(): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [GATE], { encoding: "utf8", cwd: process.cwd() });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("Alpha 0 assisted-dogfood gate", () => {
  it(
    "passes once the extension is built",
    { timeout: 120_000 },
    async () => {
      execFileSync("npm", ["run", "build"], { encoding: "utf8", cwd: process.cwd() });
      const result = runGate();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ALPHA 0 OK");
    },
  );
});
