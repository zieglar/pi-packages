import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { APPROVED_RUNTIME_TUPLES, REQUIRED_SQLITE_CAPABILITIES, assertRuntimeEligibility, type RuntimeIdentity } from "../storage/runtime.js";

/** These are locations, not PATH search. Every discovered file still needs admission. */
const SYSTEM_DIRECTORIES = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"] as const;
export class ExecutableRefusal extends Error {
  constructor(readonly code: "CE_EXECUTABLE_UNTRUSTED" | "CE_NODE_INELIGIBLE") {
    super(code);
    this.name = "ExecutableRefusal";
  }
}
export interface ExecutableTrustOptions { readonly projectRoot?: string; }
const untrusted = (): never => { throw new ExecutableRefusal("CE_EXECUTABLE_UNTRUSTED"); };
function within(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function currentProjectRoot(): string | undefined {
  let directory = realpathSync(process.cwd());
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
/** macOS ACL grants are independent of POSIX mode. Only absent ACLs or
 * deny-only ACLs are admitted; unknown output/probe failure is fail-closed.
 * The OS utility is fixed, never discovered through PATH or supplied by callers. */
function assertDarwinAclSafe(path: string): void {
  if (process.platform !== "darwin") return;
  const output = execFileSync("/bin/ls", ["-lde", path], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    shell: false, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = output.trimEnd().split("\n");
  const header = lines.shift() ?? "";
  if (!/^[bcdlps-][rwxStTs-]{9}[+@ ]/.test(header)) untrusted();
  for (const entry of lines) {
    if (!/^\s*\d+: \S+ deny [a-z_,]+$/.test(entry)) untrusted();
  }
  if (header[10] === "+" && lines.length === 0) untrusted();
}

/** Admission is deliberately before probing. Same-account filesystem mutation is
 * outside this boundary; a private installation is required, not a signature claim. */
function admitPath(path: string, options: ExecutableTrustOptions, kind: "executable" | "directory"): string {
  try {
    if (!isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) untrusted();
    const project = options.projectRoot === undefined ? currentProjectRoot() : realpathSync(options.projectRoot);
    const uid = process.geteuid?.();
    if (uid === undefined) untrusted();
    const visited = new Set<string>();
    const check = (candidate: string): void => {
      if (visited.has(candidate)) return;
      if (visited.size >= 256 || (project !== undefined && within(project, candidate)) || candidate.split(sep).some((part) => part === "node_modules" || part === ".git")) untrusted();
      visited.add(candidate);
      const stat = lstatSync(candidate);
      if (stat.uid !== 0 && stat.uid !== uid) untrusted();
      if (!stat.isSymbolicLink()) {
        assertDarwinAclSafe(candidate);
        // OS-owned sticky temp roots protect independently owned private children.
        const stickyRoot = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        if ((stat.mode & 0o022) !== 0 && !stickyRoot) untrusted();
      }
      const parent = dirname(candidate);
      if (parent !== candidate) check(parent);
      if (stat.isSymbolicLink()) check(realpathSync(candidate));
    };
    check(path);
    const canonical = realpathSync(path);
    check(canonical);
    const stat = statSync(canonical);
    if (kind === "executable") {
      if (!stat.isFile()) untrusted();
      accessSync(canonical, constants.X_OK);
    } else if (!stat.isDirectory()) untrusted();
    return canonical;
  } catch { return untrusted(); }
}

export function admitExecutable(path: string, options: ExecutableTrustOptions = {}): string {
  return admitPath(path, options, "executable");
}
export function admitInstallationDirectory(path: string, options: ExecutableTrustOptions = {}): string {
  return admitPath(path, options, "directory");
}

// Inline probe imports builtins only; no project loader, package resolution,
// configuration, Store, credentials, network or inherited Node options.
const NODE_PROBE = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
try {
  const row = db.prepare('SELECT sqlite_source_id() AS sourceId').get();
  const compileOptions = db.prepare('PRAGMA compile_options').all().map(option => {
    const value = Object.values(option)[0];
    if (typeof value !== 'string') throw new Error('invalid compile option');
    return value;
  }).sort();
  db.enableDefensive(true);
  db.exec('PRAGMA writable_schema=ON');
  if (db.prepare('PRAGMA writable_schema').get()?.writable_schema !== 0) throw new Error('defensive mode unavailable');
  db.exec('CREATE TABLE runtime_probe (value INTEGER); BEGIN');
  if (db.isTransaction !== true) throw new Error('transaction state unavailable');
  if (db.prepare('INSERT INTO runtime_probe VALUES (?)').run(1).changes !== 1
      || db.prepare('SELECT value FROM runtime_probe').get()?.value !== 1
      || db.prepare('SELECT value FROM runtime_probe').all().length !== 1) throw new Error('statement APIs unavailable');
  db.exec('ROLLBACK');
  if (db.isTransaction !== false) throw new Error('transaction state unavailable');
  process.stdout.write(JSON.stringify({nodeVersion:process.version,sqliteVersion:process.versions.sqlite,sqliteSourceId:row.sourceId,platform:process.platform,arch:process.arch,compileOptions,sqliteCapabilities:${JSON.stringify(REQUIRED_SQLITE_CAPABILITIES)}}));
} finally { db.close(); }
`;
export function qualifyNodeExecutable(path: string, options: ExecutableTrustOptions = {}): RuntimeIdentity {
  const canonical = admitExecutable(path, options);
  try {
    const text = execFileSync(canonical, ["--input-type=commonjs", "-e", NODE_PROBE], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      shell: false, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const identity = JSON.parse(text) as RuntimeIdentity;
    assertRuntimeEligibility(identity);
    return identity;
  } catch { throw new ExecutableRefusal("CE_NODE_INELIGIBLE"); }
}

export interface ExecutableResolutionOptions extends ExecutableTrustOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  /** Dependency injection for controlled discovery tests; never taken from PATH. */
  readonly systemDirectories?: readonly string[];
  readonly homeDir?: string;
}
export function resolveApprovedNode(options: ExecutableResolutionOptions = {}): string | undefined {
  const env = options.env ?? {};
  const qualify = (path: string): string => {
    const canonical = admitExecutable(path, options);
    qualifyNodeExecutable(canonical, options);
    return canonical;
  };
  if (env.CE_NODE_PATH !== undefined) return qualify(env.CE_NODE_PATH);
  const legacyRoot = env.MISE_DATA_DIR ?? join(options.homeDir ?? homedir(), ".local/share/mise");
  const candidates = [
    options.execPath ?? process.execPath,
    ...(options.systemDirectories ?? SYSTEM_DIRECTORIES).map((directory) => join(directory, "node")),
    ...(isAbsolute(legacyRoot) ? APPROVED_RUNTIME_TUPLES.map(({ nodeVersion }) => join(legacyRoot, "installs/node", nodeVersion.slice(1), "bin/node")) : []),
  ];
  for (const path of new Set(candidates)) {
    try { return qualify(path); } catch { /* Discovery candidates may be absent or unqualified. */ }
  }
  return undefined;
}

export type TunnelClientDiagnosis = "TRUSTED_METADATA_ONLY" | "CE_TUNNEL_CLIENT_MISSING" | "CE_EXECUTABLE_UNTRUSTED";

/** Diagnostic-only closed outcome. Same runtime admission, retaining discovery
 * refusals instead of laundering rejected installations as absent. Explicit
 * overrides are authoritative: even an absent override is a refusal. */
export function diagnoseTunnelClient(options: ExecutableResolutionOptions = {}): TunnelClientDiagnosis {
  const env = options.env ?? {};
  if (env.CE_TUNNEL_CLIENT_PATH !== undefined) {
    try { admitExecutable(env.CE_TUNNEL_CLIENT_PATH, options); return "TRUSTED_METADATA_ONLY"; }
    catch { return "CE_EXECUTABLE_UNTRUSTED"; }
  }
  let rejected = false;
  for (const directory of options.systemDirectories ?? SYSTEM_DIRECTORIES) {
    const candidate = join(directory, "tunnel-client");
    try { lstatSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") rejected = true;
      continue;
    }
    try { admitExecutable(candidate, options); return "TRUSTED_METADATA_ONLY"; }
    catch { rejected = true; }
  }
  return rejected ? "CE_EXECUTABLE_UNTRUSTED" : "CE_TUNNEL_CLIENT_MISSING";
}

/** Discovery is metadata-only: never execute a client to find or qualify it. */
export function resolveTunnelClient(options: ExecutableResolutionOptions = {}): string | undefined {
  const env = options.env ?? {};
  if (env.CE_TUNNEL_CLIENT_PATH !== undefined) return admitExecutable(env.CE_TUNNEL_CLIENT_PATH, options);
  for (const directory of options.systemDirectories ?? SYSTEM_DIRECTORIES) {
    try { return admitExecutable(join(directory, "tunnel-client"), options); } catch { /* Next controlled location. */ }
  }
  return undefined;
}
