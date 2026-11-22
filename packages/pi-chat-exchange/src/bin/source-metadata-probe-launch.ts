import { closeSync, constants, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSourceMetadataProbe, type SourceMetadataProbe } from "../control/mcp/source-metadata-probe.js";
import { readPrivateMessagingFile } from "../tunnel/messaging-config.js";

/** A private, short-lived launch opt-in; the observation file is also the one-use claim. */
export function createLaunchSourceMetadataProbe(bindingPath: string, launchDigest: string): SourceMetadataProbe {
  const controlPath = bindingPath + ".source-metadata-probe.json";
  return metadata => {
    let fd: number | undefined;
    try {
      const parent = lstatSync(dirname(bindingPath));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.geteuid?.() || (parent.mode & 0o7777) !== 0o700) return;
      const file = readPrivateMessagingFile(controlPath);
      if (file === undefined) return;
      const parsed: unknown = JSON.parse(file.bytes.toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const control = parsed as Record<string, unknown>;
      const now = Date.now();
      if (Object.keys(control).length !== 3 || control.version !== 1 || control.launchDigest !== launchDigest ||
          typeof control.expiresAt !== "number" || !Number.isSafeInteger(control.expiresAt) ||
          control.expiresAt <= now || control.expiresAt - now > 600_000) return;
      const sample = createSourceMetadataProbe(launchDigest, launchDigest, row => {
        writeFileSync(fd!, JSON.stringify(row) + "\n");
        fsyncSync(fd!);
      });
      if (sample === undefined) return;
      // Exclusive creation consumes the trial before reading source metadata.
      // Existing or partial output is never overwritten, appended to, or retried.
      fd = openSync(controlPath + ".observation.json", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fsyncSync(fd);
      const parentFd = openSync(dirname(bindingPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      sample(metadata);
    } catch { /* Missing/invalid opt-in and observation failures never affect ping. */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
  };
}
