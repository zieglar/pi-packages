import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyManagedMcpChild, type ProcessTreeEntry } from "../../src/tunnel/live-process-observation.js";

const uid = process.geteuid!();
const run = { runId: "bg-test", managedPid: 100, identityConfirmed: true as const };
const paths = { nodePath: process.execPath, scriptPath: "/tmp/mcp-stdio.js", bindingPath: "/tmp/binding.json" };
const command = `${paths.nodePath} ${paths.scriptPath} --config ${paths.bindingPath}`;
const row = (pid: number, ppid: number, cmd: string): ProcessTreeEntry => ({ pid, ppid, uid, startedKey: "Tue Nov  3 10:00:00 2026", command: cmd });
const base = [row(100, 1, "managed client"), row(101, 100, command)];
const input = () => ({ run, ...paths, recheckRun: async () => run, inspect: async () => base });

describe("managed MCP child verification", () => {
  it("accepts an exact same-user descendant stable across two snapshots", async () => {
    await expect(verifyManagedMcpChild(input())).resolves.toEqual({ pid: 101, startedKey: base[1]!.startedKey, command, runId: run.runId });
  });
  it.each(["sibling", "binding", "wrapper", "ambiguous", "loop", "missing", "uid", "unknown", "reuse", "ancestry", "anchor", "run"])("refuses %s", async (variant) => {
    let calls = 0;
    const opts = input();
    opts.inspect = async () => {
      calls++;
      const rows = base.map(r => ({ ...r }));
      if (variant === "sibling") rows[1]!.ppid = 1;
      if (variant === "binding") rows[1]!.command += "-wrong";
      if (variant === "wrapper") rows[1]!.command = `/bin/sh -c ${command}`;
      if (variant === "ambiguous") rows.push(row(102, 100, command));
      if (variant === "loop") { rows[1]!.ppid = 102; rows.push(row(102, 101, "wrapper")); }
      if (variant === "missing") rows[1]!.ppid = 999;
      if (variant === "uid") rows[1]!.uid++;
      if (calls === 2 && variant === "reuse") rows[1]!.startedKey += "changed";
      if (calls === 2 && variant === "ancestry") rows[1]!.ppid = 1;
      if (calls === 2 && variant === "anchor") rows[0]!.startedKey += "changed";
      return variant === "unknown" ? undefined as never : rows;
    };
    if (variant === "run") opts.recheckRun = async () => ({ ...run, runId: "other" });
    await expect(verifyManagedMcpChild(opts)).resolves.toBeUndefined();
  });
});

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill();
  })));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it("verifies an actual synthetic Node parent/child tree using /bin/ps", async () => {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-process-observe-")); dirs.push(dir);
  const scriptPath = join(dir, "mcp-stdio.js");
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000)");
  const parent = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,process.argv.slice(1),{stdio:'ignore'}); console.log(c.pid); process.on('SIGTERM',()=>{c.kill();c.once('exit',()=>process.exit(0));});setInterval(()=>{},1000)", scriptPath, "--config", paths.bindingPath], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(parent);
  const childPid = await new Promise<number>((resolve, reject) => {
    parent.once("error", reject); parent.stdout!.once("data", data => resolve(Number(String(data).trim())));
  });
  const actualRun = { ...run, managedPid: parent.pid! };
  const result = await verifyManagedMcpChild({ run: actualRun, ...paths, scriptPath, recheckRun: async () => actualRun });
  expect(result?.pid).toBe(childPid);
  expect(result?.runId).toBe(run.runId);
});
