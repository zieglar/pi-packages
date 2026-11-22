#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createProbeRun, evaluateProbeRun, parseProbeObservation, parseProbeRun, recordProbeObservation, type ProbeDirection, type ProbeMode, type ProbeRun } from "../probe/notification-harness.js";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const mode = (process.argv[2]?.startsWith("-") ? undefined : process.argv[2]) as ProbeMode | undefined;
const evidencePath = value("--evidence");
const recordPath = value("--record");
const recording = evidencePath !== undefined && recordPath !== undefined;
let run: ProbeRun;

if (evidencePath !== undefined && recordPath !== undefined) {
  run = parseProbeRun(JSON.parse(readFileSync(evidencePath, "utf8")));
  const observation = parseProbeObservation(JSON.parse(readFileSync(recordPath, "utf8")));
  run = recordProbeObservation(run, observation);
} else {
  const endpoint = value("--endpoint");
  run = createProbeRun({ ...(mode ? { mode } : {}), ...(endpoint ? { endpoint } : {}), sendAuthorized: process.argv.includes("--authorize-send") });
}

const output = `${JSON.stringify({ ...run, verdict: evaluateProbeRun(run) }, null, 2)}\n`;
if (evidencePath) { writeFileSync(evidencePath, output, { encoding: "utf8", mode: 0o600, flag: recording ? "w" : "wx" }); chmodSync(evidencePath, 0o600); }
else process.stdout.write(output);

if (run.mode !== "dry-run" && run.observations.length === 0) {
  const directions: ProbeDirection[] = run.mode === "both" ? ["pi-to-chatgpt", "chatgpt-to-pi"] : [run.mode];
  process.stderr.write(`READY run=${run.runId} nonce=${run.nonce} endpoint=${run.endpoint} directions=${directions.join(",")}\n`);
}
