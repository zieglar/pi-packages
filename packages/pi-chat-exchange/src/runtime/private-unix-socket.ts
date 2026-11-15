import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

/** Protect the path against replacement by a different OS user; same-UID processes are trusted. */
export function assertPrivateSocketDirectory(socketPath: string): void {
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath) throw new Error("MCP socket path must be absolute and canonical");
  const socketDirectory = dirname(socketPath);
  if (realpathSync(socketDirectory) !== socketDirectory) throw new Error("MCP socket directory must be canonical");
  for (let path = socketDirectory; ; path = dirname(path)) {
    const stat = lstatSync(path);
    const uid = process.geteuid?.();
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
        (!stickyRoot && (stat.mode & 0o022) !== 0) ||
        (path === socketDirectory && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
      throw new Error("MCP socket directory or ancestor is not private and trusted");
    }
    // A Darwin ACL can grant access independently of POSIX mode.
    if (process.platform === "darwin") {
      let acl: string;
      try {
        acl = execFileSync("/bin/ls", ["-lde", path], {
          encoding: "utf8", timeout: 5_000, maxBuffer: 16_384,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch { throw new Error("MCP socket directory ACL could not be verified"); }
      const [header = "", ...entries] = acl.trimEnd().split("\n");
      if (!/^[bcdlps-][rwxStTs-]{9}[+@ ]/.test(header) ||
          entries.some(entry => !/^\s*\d+: \S+ deny [a-z_,]+$/.test(entry)) ||
          (header[10] === "+" && entries.length === 0)) {
        throw new Error("MCP socket directory ACL must not grant access");
      }
    }
    if (dirname(path) === path) break;
  }
}

/** Revalidate before Tunnel spawn; a restarted Runtime may create a new inode. */
export function assertPrivateUnixSocket(socketPath: string): void {
  assertPrivateSocketDirectory(socketPath);
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.uid !== process.geteuid?.() || (socket.mode & 0o7777) !== 0o600) {
    throw new Error("MCP socket must be private and owned by the current user");
  }
}
