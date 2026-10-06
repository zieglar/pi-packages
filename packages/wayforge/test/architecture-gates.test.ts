import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CHECKER = join(process.cwd(), "scripts", "check-architecture.mjs");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }));
  }
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wayforge-arch-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function runChecker(root: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [CHECKER, root], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("architecture gates over production source", () => {
  it("passes on the real src tree with a sentinel summary", () => {
    const result = runChecker(join(process.cwd(), "src"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARCHITECTURE OK");
    expect(result.stdout).toMatch(/scanned \d+ files/i);
  });
  it("rejects completion-budget reservation outside the controller owner", () => {
    const result = runChecker(fixture({
      "runtime/rogue.ts": "const context = parent.reserveCompletionBudget();",
    }));
    expect(result.stdout).toContain("completion budget reservation");
  });

  it("rejects authority-review invocation outside the controller callback", () => {
    const result = runChecker(fixture({
      "recovery/rogue.ts": "controller.reviewCompletionEvidence(evidence);",
    }));
    expect(result.stdout).toContain("authoritative Advisor review callback");
  });

  it("rejects governed controller advice without the non-consuming guard", () => {
    const result = runChecker(fixture({
      "workflow/workflow-controller.ts": "advise() { return this.reviewAdvisorEvidence(e); } reserve() { return parent.reserveCompletionBudget(); }",
    }));
    expect(result.stdout).toContain("governed advice must refuse before review");
  });

  it("rejects authoritative advisor diagnostic emission outside the controller", () => {
    const result = runChecker(fixture({
      "adapters/rogue.ts": "const e = log.emit(\"advisor_review_diagnostic\", { taskId, detail });",
    }));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("adapters/rogue.ts");
    expect(result.stdout).toContain("authoritative advisor diagnostic emission");
  });

  it("allows the controller to own authoritative advisor diagnostic emission", () => {
    const result = runChecker(fixture({
      "runtime/pi-compatibility-adapter.ts":
        "export class PiCompatibilityAdapter { async apply() { return pi.setModel(m); } }\n",
      "extension.ts":
        "import { PiCompatibilityAdapter } from \"./runtime/pi-compatibility-adapter.js\";\n" +
        "import { MainModelController } from \"./runtime/main-model-controller.js\";\n" +
        "import { CompletionAuthority } from \"./completion/completion-authority.js\";\n" +
        "const adapter = new PiCompatibilityAdapter(pi, ctx);\n" +
        "const main = new MainModelController(adapter);\n" +
        "const completion = new CompletionAuthority(options);\n",
      "workflow/runtime-factory.ts":
        "import { RecoveryCoordinator } from \"../recovery/recovery-coordinator.js\";\n" +
        "import { HealthRegistry } from \"../recovery/health-registry.js\";\n" +
        "import { HealthProjector } from \"../recovery/health-projector.js\";\n" +
        "const coordinator = new RecoveryCoordinator();\n" +
        "const health = new HealthRegistry();\n" +
        "const projector = new HealthProjector(health);\n",
      "workflow/workflow-controller.ts":
        "  advise(input) {\n" +
        "    if (this.options.completionAuthority !== undefined) {\n" +
        "      return failure({ code: \"advisor_reserved_for_completion\" });\n" +
        "    }\n" +
        "    return this.reviewAdvisorEvidence(e);\n" +
        "  }\n" +
        "  private reviewCompletionEvidence(evidence) {\n" +
        "    const parent = this.options.mainContext.reserveCompletionBudget();\n" +
        "    return this.reviewAdvisorEvidence(evidence, \"before_done\", parent);\n" +
        "  }\n" +
        "  requestCompletion({ review: (evidence) => this.reviewCompletionEvidence(evidence) });\n" +
        "  this.log.emit(\"advisor_review_diagnostic\", { taskId });\n",
      "adapters/rogue.ts": "const e = log.emit(\"budget_changed\", { taskId });",
    }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("19 gates passed");
  });


  it("fails when a second setModel( callsite exists outside the adapter", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "runtime/rogue.ts": "export const b = () => session.setModel(m);\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("runtime/rogue.ts");
    expect(result.stdout).toMatch(/setModel/i);
  });

  it("fails when the only setModel( callsite is not in the adapter", () => {
    const dir = fixture({
      "runtime/rogue.ts": "export const b = () => session.setModel(m);\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("runtime/rogue.ts");
  });

  it("fails on direct low-level pi-ai compatibility imports", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "runtime/sneaky.ts": 'import { streamSimple } from "@earendil-works/pi-ai/compat";\n',
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("pi-ai");
    expect(result.stdout).toContain("runtime/sneaky.ts");
  });

  it("fails when a module outside the adapter or extension imports Pi APIs", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "kernel/greedy.ts": 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n',
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("kernel/greedy.ts");
  });

  it("fails when a module outside the adapter or extension deep-imports Pi APIs", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "kernel/sneaky.ts":
        'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";\n',
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("kernel/sneaky.ts");
  });

  it("fails when adapter contracts expose forbidden lifecycle or fallback authority", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "adapters/contracts.ts":
        "export interface Rogue { setModel(m: unknown): void; retryLoop(): void; abort(): void; continueSession(): void; }\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("adapters/contracts.ts");
    expect(result.stdout).toMatch(/forbidden/i);
  });

  it("fails when recovery owns a fallback loop", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "recovery/recovery-coordinator.ts":
        "export class C { retryLoop(): void {} fallbackLoop(): void {} }\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("recovery/recovery-coordinator.ts");
  });
  it("fails when RecoveryCoordinator is constructed outside the runtime factory", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "kernel/rogue-recovery.ts": "export const c = new RecoveryCoordinator();\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("RecoveryCoordinator");
    expect(result.stdout).toContain("workflow/runtime-factory.ts");
  });

  it("fails when HealthRegistry or HealthProjector is constructed outside the runtime factory", () => {
    const registry = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "recovery/rogue.ts": "export const h = new HealthRegistry();\n",
    });
    expect(runChecker(registry).stdout).toContain("HealthRegistry");
    const projector = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "adapters/rogue.ts": "export const p = new HealthProjector();\n",
    });
    expect(runChecker(projector).stdout).toContain("HealthProjector");
  });

  it("fails when live-Pi components are constructed outside extension.ts", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "workflow/rogue.ts": "export const x = new PiCompatibilityAdapter(pi, ctx);\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("PiCompatibilityAdapter");
    expect(result.stdout).toContain("extension.ts");
  });

  it("fails on pi-subagents imports outside the public delegation contract", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "adapters/rogue.ts": 'import { agents } from "pi-subagents/agents";\n',
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("pi-subagents/agents");
    expect(result.stdout).toContain("pi-subagents/delegation");
  });

  it("passes a minimal tree that respects every ownership boundary", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts":
        "export class PiCompatibilityAdapter { async apply() { return pi.setModel(m); } }\n",
      "extension.ts":
        "import { PiCompatibilityAdapter } from \"./runtime/pi-compatibility-adapter.js\";\n" +
        "import { MainModelController } from \"./runtime/main-model-controller.js\";\n" +
        "import { CompletionAuthority } from \"./completion/completion-authority.js\";\n" +
        "const adapter = new PiCompatibilityAdapter(pi, ctx);\n" +
        "const main = new MainModelController(adapter);\n" +
        "const completion = new CompletionAuthority(options);\n",
      "workflow/runtime-factory.ts":
        "import { RecoveryCoordinator } from \"../recovery/recovery-coordinator.js\";\n" +
        "import { HealthRegistry } from \"../recovery/health-registry.js\";\n" +
        "import { HealthProjector } from \"../recovery/health-projector.js\";\n" +
        "const coordinator = new RecoveryCoordinator();\n" +
        "const health = new HealthRegistry();\n" +
        "const projector = new HealthProjector(health);\n",
    });
    const result = runChecker(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("19 gates passed");
  });

  it("fails when CompletionAuthority has a second production construction site", () => {
    const dir = fixture({
      "extension.ts": "const completion = new CompletionAuthority(options);\n",
      "runtime/rogue.ts": "const second = new CompletionAuthority(options);\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("CompletionAuthority");
    expect(result.stdout).toContain("runtime/rogue.ts");
  });

  it("fails on durable completed writers or completion CAS outside the authority", () => {
    const dir = fixture({
      "extension.ts": "const completion = new CompletionAuthority(options);\n",
      "runtime/durable-task-projection.ts":
        "const next = { ...state, status: \"completed\", completionEvidence: evidence };\n" +
        "store.update(state.revision, next);\n" +
        "state.setStatus(\"completed\");\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("runtime/durable-task-projection.ts");
    expect(result.stdout).toMatch(/completed|completion evidence/i);
  });

  it("fails on completion CAS (store.update into a completed state) outside the authority", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts": "export const a = () => pi.setModel(m);\n",
      "extension.ts": "const completion = new CompletionAuthority(options);\n",
      "runtime/rogue-completion.ts":
        "export async function complete(store, state, lease, evidence) {\n" +
        "  return store.update(state.revision, { ...state, status: \"completed\", completionEvidence: evidence }, lease);\n" +
        "}\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("runtime/rogue-completion.ts:2");
    expect(result.stdout).toMatch(/completion CAS/);
    expect(result.stdout).toContain("completion/completion-authority.ts");
  });

  it("allows non-completion durable store updates and update-shaped comments outside the authority", () => {
    const dir = fixture({
      "runtime/pi-compatibility-adapter.ts":
        "export class PiCompatibilityAdapter { async apply() { return pi.setModel(m); } }\n",
      "extension.ts":
        "import { PiCompatibilityAdapter } from \"./runtime/pi-compatibility-adapter.js\";\n" +
        "import { MainModelController } from \"./runtime/main-model-controller.js\";\n" +
        "import { CompletionAuthority } from \"./completion/completion-authority.js\";\n" +
        "const adapter = new PiCompatibilityAdapter(pi, ctx);\n" +
        "const main = new MainModelController(adapter);\n" +
        "const completion = new CompletionAuthority(options);\n",
      "workflow/runtime-factory.ts":
        "import { RecoveryCoordinator } from \"../recovery/recovery-coordinator.js\";\n" +
        "import { HealthRegistry } from \"../recovery/health-registry.js\";\n" +
        "import { HealthProjector } from \"../recovery/health-projector.js\";\n" +
        "const coordinator = new RecoveryCoordinator();\n" +
        "const health = new HealthRegistry();\n" +
        "const projector = new HealthProjector(health);\n",
      "recovery/wakeup-service.ts":
        "// store.update(revision, completedState, lease) is a projection concern, not a write here.\n" +
        "export async function suspend(store, state, lease) {\n" +
        "  return store.update(state.revision, { ...state, status: \"suspended\" }, lease);\n" +
        "}\n" +
        "export async function rekey(store, state) {\n" +
        "  return store.update(state.revision, { ...state, completionEvidence: null });\n" +
        "}\n",
    });
    const result = runChecker(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("19 gates passed");
  });

  it("fails when an accounts protocol channel appears outside the dedicated adapter", () => {
    const dir = fixture({
      "extension.ts": "const completion = new CompletionAuthority(options);\n",
      "runtime/rogue.ts": "export const protocol = \"accounts:topology:v1\";\n",
    });
    const result = runChecker(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("accounts protocol channels");
  });

});
