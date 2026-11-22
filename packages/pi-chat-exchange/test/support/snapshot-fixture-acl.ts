import * as childProcess from "node:child_process";
import { sep } from "node:path";
import { vi } from "vitest";

/** These private fixtures never mutate ACLs. Reuse the actual OS reply for each
 * path instead of spawning ls for every policy read. File stats, modes, policy
 * bytes and every other subprocess remain real. Do not use in ACL-change tests. */
export function snapshotFixtureAcl(root: string): void {
  // vi.spyOn reuses an existing spy; capture its implementation so a second
  // private fixture in the same test cannot make the wrapper call itself.
  const current = childProcess.execFileSync;
  const probe = vi.isMockFunction(current) ? current.getMockImplementation() : current;
  if (probe === undefined) throw new Error("Fixture ACL probe has no implementation");
  const replies = new Map<string, ReturnType<typeof probe>>();
  vi.spyOn(childProcess, "execFileSync").mockImplementation(((...args: Parameters<typeof probe>) => {
    const paths = args[1];
    if (args[0] === "/bin/ls" && Array.isArray(paths) && paths.length === 2 && paths[0] === "-lde") {
      const path = paths[1] as string;
      if (path === root || path.startsWith(root + sep)) {
        if (!replies.has(path)) replies.set(path, probe(...args));
        return replies.get(path)!;
      }
    }
    return probe(...args);
  }) as typeof probe);
}
