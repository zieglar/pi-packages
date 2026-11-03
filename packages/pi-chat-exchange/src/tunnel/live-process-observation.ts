/** Read-only process evidence, not Owner/port readiness or future availability.
 * ps exposes rendered argv, not lossless argv boundaries. Space-bearing paths
 * and shell wrapper candidates therefore remain UNVERIFIED; never guess their
 * quoting. macOS/Linux snapshots are bounded and errors disclose no diagnostics.
 */
import { execFile } from "node:child_process";
import { buildTunnelMcpCommand } from "./profile.js";

export interface ManagedRunIdentity {
  readonly runId: string;
  readonly managedPid: number;
  readonly identityConfirmed: true;
}
export interface ProcessTreeEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly startedKey: string;
  readonly command: string;
}
export interface VerifiedManagedMcpChild {
  readonly pid: number;
  readonly startedKey: string;
  readonly command: string;
  readonly runId: string;
}
export interface ManagedMcpChildObservationOptions {
  readonly run: ManagedRunIdentity;
  readonly bindingPath: string;
  readonly scriptPath: string;
  readonly nodePath: string;
  /** Must freshly re-observe the manager, not return a cached input identity. */
  readonly recheckRun: () => Promise<ManagedRunIdentity | undefined>;
  /** Test seam. Undefined means unknown, never an empty successful snapshot. */
  readonly inspect?: () => Promise<readonly ProcessTreeEntry[] | undefined>;
}

function snapshot(): Promise<readonly ProcessTreeEntry[] | undefined> {
  if (process.platform !== "darwin" && process.platform !== "linux") return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,uid=,lstart=,args="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      const rows: ProcessTreeEntry[] = [];
      for (const line of stdout.trimEnd().split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
        if (!match) return resolve(undefined);
        rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startedKey: match[4]!, command: match[5]! });
      }
      resolve(rows);
    });
  });
}

/** Two stable same-user ancestry snapshots plus fresh manager revalidation.
 * Wrappers may be intermediate ancestors, but only the exact Node invocation
 * can be the candidate. No process is signalled, spawned, adopted or mutated.
 */
export async function verifyManagedMcpChild(options: ManagedMcpChildObservationOptions): Promise<VerifiedManagedMcpChild | undefined> {
  try {
    const { run } = options;
    const uid = process.geteuid?.();
    if (uid === undefined || run.identityConfirmed !== true || !run.runId.trim() || !Number.isSafeInteger(run.managedPid) || run.managedPid <= 0) return undefined;
    const anchor = { ...run };
    const currentRun = async (): Promise<boolean> => {
      const current = await options.recheckRun();
      return current?.identityConfirmed === true && current.runId === anchor.runId && current.managedPid === anchor.managedPid;
    };
    if ([options.nodePath, options.scriptPath, options.bindingPath].some(p => /\s/.test(p))) return undefined;
    const expected = buildTunnelMcpCommand(options);
    if (!await currentRun()) return undefined;
    const inspect = options.inspect ?? snapshot;
    const capture = async (): Promise<readonly ProcessTreeEntry[] | undefined> => {
      const rows = await inspect();
      if (!rows || rows.length > 65536) return undefined;
      const map = new Map<number, ProcessTreeEntry>();
      for (const r of rows) {
        if (!Number.isSafeInteger(r.pid) || r.pid < 0 || !Number.isSafeInteger(r.ppid) || r.ppid < 0 ||
          !Number.isSafeInteger(r.uid) || !r.startedKey || !r.command || map.has(r.pid)) return undefined;
        map.set(r.pid, { ...r });
      }
      const manager = map.get(anchor.managedPid);
      if (!manager || manager.uid !== uid) return undefined;
      const candidates: ProcessTreeEntry[][] = [];
      for (const candidate of map.values()) {
        if (candidate.pid === manager.pid || candidate.command !== expected) continue;
        const path: ProcessTreeEntry[] = [];
        const seen = new Set<number>();
        let cursor: ProcessTreeEntry | undefined = candidate;
        while (cursor && !seen.has(cursor.pid) && cursor.uid === uid) {
          seen.add(cursor.pid); path.push(cursor);
          if (cursor.pid === manager.pid) { candidates.push(path); break; }
          cursor = map.get(cursor.ppid);
        }
      }
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const first = await capture();
    if (!first || !await currentRun()) return undefined;
    const second = await capture();
    if (!second || first.length !== second.length || first.some((r, i) => {
      const other = second[i]!;
      return r.pid !== other.pid || r.ppid !== other.ppid || r.uid !== other.uid || r.startedKey !== other.startedKey || r.command !== other.command;
    }) || !await currentRun()) return undefined;
    const child = second[0]!;
    return Object.freeze({ pid: child.pid, startedKey: child.startedKey, command: child.command, runId: anchor.runId });
  } catch { return undefined; }
}
