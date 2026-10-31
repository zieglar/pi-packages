// npm release preflight and one-shot trusted publication.
//
// This module never creates or uses a long-lived npm token. Publication is
// attempted exactly once and never retried; no explicit dist-tag command is issued.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPackageArtifact } from "./package-pi-extension.mjs";
import { assertTunnelReleaseReady } from './tunnel-compat.mjs';

export const PACKAGE_NAME = "@zieglar/pi-chat-exchange";
export const REPOSITORY_URL = "git+https://github.com/zieglar/pi-packages.git";
export const NATIVE_RELEASE_FILES = new Set(["SHA256SUMS", "provenance.jsonl", "native-manifest.json", "native-identities.json"]);
const REQUIRED_NATIVE_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];

// npm errors are not proof of absence. Only a clean registry answer is
// accepted; transport, permission and parse failures all refuse publication.
export function runNpm(args, cwd = process.cwd(), env = process.env) {
  const child = { ...env };
  delete child.NPM_TOKEN;
  delete child.GH_TOKEN;
  delete child.GITHUB_TOKEN;
  delete child.CE_RELEASE_ADMIN_TOKEN;
  try {
    return { status: 0, stdout: execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: child }) };
  } catch (error) {
    return { status: error.status ?? -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

export function assertPublishIdentity({ expectedSha, actualSha }) {
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error("an explicit publish commit SHA is required; refusing release");
  }
  if (expectedSha !== actualSha) throw new Error("publish commit SHA does not match the dispatched commit; refusing release");
}

export function readPackageMetadata(directory) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); }
  catch { throw new Error("package.json is unreadable or invalid JSON; refusing release"); }
  if (pkg.name !== PACKAGE_NAME) throw new Error("unexpected npm package name; refusing release");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version ?? "")) throw new Error("package version must be a concrete semver version");
  if (pkg.repository?.url !== REPOSITORY_URL) {
    throw new Error("package.json repository.url must exactly match the GitHub repository");
  }
  return pkg;
}

export function assertVersionAbsent(pkg, directory, run = runNpm) {
  const result = run(["view", `${pkg.name}@${pkg.version}`, "version", "--json"], directory);
  if (result.status === 0) throw new Error("version already exists on npm; no overwrite or retry");
  const evidence = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
  // Only an explicit npm E404 (the package/version is absent) is accepted. Any
  // other failure — including proxy text containing 404 — is not proof of absence.
  if (!/\be404\b/i.test(evidence)) {
    throw new Error("npm registry version state is unreadable; refusing release");
  }
}

/** Publication authority for the Native-default build. Use the same compiled
 * manifest and validator as runtime, then require the declared default version's
 * complete target set to be pinned. Native default and pins are one release unit. */
export function assertNativeDefaultPublishable({ manifest, parseNativeCompat }) {
  let compat;
  try { compat = parseNativeCompat(manifest); }
  catch { throw new Error("Native default requires a valid production compatibility manifest and verified trust pins; publication refused"); }
  const assets = compat.versions[compat.defaultVersion]?.assets;
  const valid = assets !== undefined && REQUIRED_NATIVE_TARGETS.every(target => {
    const asset = assets[target];
    return asset?.asset === `ce-sqlite-${compat.defaultVersion}-${target}.node`
      && typeof asset.sha256 === "string" && /^[0-9a-f]{64}$/.test(asset.sha256);
  });
  if (!valid) throw new Error("Native default requires verified production trust pins; publication with null or incomplete pins is refused");
}

export async function preflight({ directory = process.cwd(), expectedSha = process.env.EXPECTED_SHA, actualSha = process.env.GITHUB_SHA, run = runNpm } = {}) {
  assertPublishIdentity({ expectedSha, actualSha });
  const pkg = readPackageMetadata(directory);
  // Read the actual built manifest, never evaluate a TypeScript source expression.
  const compatModule = await import(pathToFileURL(join(directory, "dist/storage/native-compat.js")).href);
  assertNativeDefaultPublishable({ manifest: compatModule.NATIVE_COMPAT, parseNativeCompat: compatModule.parseNativeCompat });
  await assertTunnelReleaseReady({ directory });
  assertVersionAbsent(pkg, directory, run);
  const { artifactPath, inventory } = buildPackageArtifact({ root: directory, out: join(directory, ".pi-artifacts"), run });
  return { name: pkg.name, version: pkg.version, fileCount: inventory.length, artifactPath };
}

// One attempt, no retry, no explicit dist-tag command. OIDC trusted publishing is the
// only supported credential path here. Publish exactly the validated preflight tarball.
export function publishOnce({ artifactPath, env = process.env, run = runNpm } = {}) {
  if (env.NPM_TOKEN) throw new Error("long-lived NPM_TOKEN must not be used; refusing release");
  if (typeof artifactPath !== "string" || !artifactPath.endsWith(".tgz")) throw new Error("a validated preflight tarball is required; refusing release");
  const result = run(["publish", artifactPath], undefined, env);
  if (result.status !== 0) throw new Error("npm publish failed; no retry and no explicit dist-tag commands");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "preflight") {
      const result = await preflight();
      console.log(`preflight passed for ${result.name}@${result.version} (${result.fileCount} files)`);
    } else if (process.argv[2] === "publish") {
      // Refuse long-lived credentials before any registry or pack invocation.
      if (process.env.NPM_TOKEN) throw new Error("long-lived NPM_TOKEN must not be used; refusing release");
      // The publish entry point cannot bypass the preflight: identity, package
      // contents and duplicate-version checks always run before the single attempt.
      const { artifactPath } = await preflight();
      publishOnce({ artifactPath });
      console.log("npm publish completed once via trusted publishing");
    } else {
      throw new Error("usage: npm-release.mjs preflight | publish");
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
