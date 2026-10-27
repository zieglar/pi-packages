import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runtime from "../../src/storage/runtime.js";
import { diagnoseInstallation, installationDiagnosticMessage } from "../../src/runtime/diagnostics.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-installation-doctor-")); roots.push(root); chmodSync(root, 0o700);
  const node = join(root, "node"); copyFileSync(process.execPath, node); chmodSync(node, 0o700);
  return { root, node, options: { env: { CE_NODE_PATH: node }, systemDirectories: [], homeDir: root } };
}
it("actually qualifies the host in memory and the selected child independently, without client execution or writes", () => {
  const f = fixture(); const probe = vi.spyOn(runtime, "assertHostRuntimeEligibility");
  const result = diagnoseInstallation(f.options);
  expect(probe).toHaveBeenCalledOnce(); expect(result).toEqual({ host: "QUALIFIED", child: "QUALIFIED", client: "CE_TUNNEL_CLIENT_MISSING" });
});
it("host failure cannot be repaired by a qualified selected child or leak its cause", () => {
  const f = fixture(); vi.spyOn(runtime, "assertHostRuntimeEligibility").mockImplementation(() => { throw Error("private-host-cause"); });
  const result = diagnoseInstallation(f.options); expect(result.host).toBe("STORAGE_RUNTIME_INELIGIBLE"); expect(result.child).toBe("QUALIFIED");
  const message = installationDiagnosticMessage(result); expect(message).toContain("restart Pi"); expect(message).toContain("CE_NODE_PATH"); expect(message).not.toContain("private-host-cause"); expect(message).not.toContain(f.root);
});
it("a qualified host cannot repair a rejected or ineligible selected child", () => {
  const f = fixture(); const path = join(f.root, "wrong-node"); writeFileSync(path, '#!/bin/sh\nprintf "private-subprocess-output"\n', { mode: 0o700 });
  const ineligible = diagnoseInstallation({ ...f.options, env: { CE_NODE_PATH: path } });
  expect(ineligible.host).toBe("QUALIFIED"); expect(ineligible.child).toBe("CE_NODE_INELIGIBLE");
  expect(installationDiagnosticMessage(ineligible)).not.toContain("private-subprocess-output");
  expect(diagnoseInstallation({ ...f.options, env: { CE_NODE_PATH: "relative-secret" } }).child).toBe("CE_EXECUTABLE_UNTRUSTED");
});
