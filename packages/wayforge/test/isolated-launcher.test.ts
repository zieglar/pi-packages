import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "pi1-dev.sh");

function script(): string {
  return readFileSync(SCRIPT, "utf8");
}

describe("isolated Alpha 0 launcher", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT], { encoding: "utf8" })).not.toThrow();
  });

  it("redirects all Pi state below the git-ignored .wayforge-dev directory", () => {
    const content = script();
    expect(content).toContain('export PI_CODING_AGENT_DIR="${DEV_DIR}/agent"');
    expect(content).toContain('export PI_CODING_AGENT_SESSION_DIR="${DEV_DIR}/sessions"');
    expect(content).toContain('DEV_DIR="${REPO_ROOT}/.wayforge-dev"');
    expect(content).toContain('export PI_TELEMETRY="0"');
    expect(content).toContain('export PI_SKIP_VERSION_CHECK="1"');
    const codeLines = content.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    for (const line of codeLines) {
      expect(line, `code line must not reference home: ${line}`).not.toMatch(/(~|\$HOME)/);
    }
  });

  it("executes only the repository-local Pi binary and preserves caller arguments", () => {
    const content = script();
    expect(content).toContain('exec "${REPO_ROOT}/node_modules/.bin/pi" "$@"');
  });

  it("loads exactly the two isolated extensions from the built output", () => {
    const content = script();
    expect(content).toContain('export { wayforgeExtension as default } from "${REPO_ROOT}/dist/extension.js"');
    expect(content).toContain('export { default } from "pi-subagents"');
    expect(content).toMatch(/--setup/);
    expect(content).not.toContain("pi-multi-account");
    expect(content).not.toContain("pi-shift-router");
    expect(content).not.toContain("pi-advisor-flow");
  });

  it("writes shims as .js, never .mjs (Pi 1.x skips .mjs silently)", () => {
    const content = script();
    expect(content).toContain('cat > "${EXT_DIR}/wayforge.js"');
    expect(content).toContain('cat > "${EXT_DIR}/pi-subagents.js"');
    expect(content).not.toContain('cat > "${EXT_DIR}/wayforge.mjs"');
    expect(content).not.toContain('cat > "${EXT_DIR}/pi-subagents.mjs"');
    expect(content).toContain('rm -f "${EXT_DIR}/wayforge.mjs" "${EXT_DIR}/pi-subagents.mjs"');
  });

  it("keeps .wayforge-dev out of version control", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/(^|\n)\.wayforge-dev\//);
  });
});
