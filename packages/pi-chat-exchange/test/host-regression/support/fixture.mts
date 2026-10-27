import type { ChildProcess } from "node:child_process";
import type { Driver } from "./harness.mjs";

/** Unit-fixture safety net for tests that intentionally make stop reject.
 * The real stop result is asserted by the caller. Never target a saved PID;
 * Node's still-owned ChildProcess handle is the only fallback authority.
 */
export async function settleFixtureDriver(driver: Driver): Promise<void> {
  await driver.stop().catch(() => {});
  const child = driver.child as ChildProcess;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("fixture driver did not reap")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
