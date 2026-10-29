// Runs on Node's loader thread; record access before refusing resolution.
import { appendFileSync } from "node:fs";
let log;
export function initialize(data) { log = data.log; }
export function resolve(specifier, context, nextResolve) {
  if (specifier === "node:sqlite" || specifier === "sqlite") {
    appendFileSync(log, "esm\n");
    throw Object.assign(new Error("test denies node:sqlite resolution"), { code: "CE_TEST_SQLITE_DENIED" });
  }
  return nextResolve(specifier, context);
}
