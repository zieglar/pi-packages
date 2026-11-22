import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export interface LaunchAgentOptions {
  readonly account: string;
  readonly name: string;
  readonly homeDir: string;
  readonly profilePath: string;
  readonly clientPath: string;
}

export interface LaunchAgentPlan extends LaunchAgentOptions {
  readonly label: string;
  readonly path: string;
  readonly plist: string;
}

const invalid = (): never => { throw new Error("CE_LAUNCHAGENT_INVALID"); };
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function currentLaunchAgentIdentity(): { readonly account: string; readonly homeDir: string } {
  try {
    const account = execFileSync("/usr/bin/whoami", [], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, shell: false,
      timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const homeDir = homedir();
    if (!account || !homeDir) invalid();
    return { account, homeDir };
  } catch { return invalid(); }
}

export function planLaunchAgent(options: LaunchAgentOptions): LaunchAgentPlan {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.name) || options.name.length > 64) invalid();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(options.account)) invalid();
  for (const path of [options.homeDir, options.profilePath, options.clientPath]) {
    if (!isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) invalid();
  }
  const account = options.account.toLowerCase().replaceAll("_", "-");
  const label = `com.${account}.pi-chat-exchange.tunnel.${options.name}`;
  const path = join(options.homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.clientPath)}</string>
    <string>run</string>
    <string>--profile-file</string>
    <string>${xml(options.profilePath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/opt/homebrew/var/log/tunnel-client.log</string>
  <key>StandardErrorPath</key>
  <string>/opt/homebrew/var/log/tunnel-client.log</string>
</dict>
</plist>
`;
  return { ...options, label, path, plist };
}

export function generateLaunchAgent(options: LaunchAgentOptions): LaunchAgentPlan {
  const plan = planLaunchAgent(options);
  const directory = join(options.homeDir, "Library", "LaunchAgents");
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const temporary = join(directory, `.${plan.label}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let targetCreated = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, plan.plist, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.chmodSync(temporary, 0o644);
    try { fs.linkSync(temporary, plan.path); targetCreated = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("CE_LAUNCHAGENT_EXISTS");
      throw error;
    }
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return plan;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) {
      // Once the target hard link exists, cleanup failure must not misreport
      // generation as failed while leaving a valid LaunchAgent behind.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !targetCreated) throw error;
    }
  }
}
