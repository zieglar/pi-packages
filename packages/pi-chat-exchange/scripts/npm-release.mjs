// npm release preflight and one-shot trusted publication.
//
// This module never creates or uses a long-lived npm token. Publication is
// attempted exactly once and never retried; dist-tags are never modified.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@zieglar/pi-chat-exchange";
export const REPOSITORY_URL = "git+https://github.com/zieglar/pi-packages.git";
export const NATIVE_RELEASE_FILES = new Set(["SHA256SUMS", "provenance.jsonl", "native-manifest.json", "native-identities.json"]);

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
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) throw new Error("package version must be a concrete semver version");
  if (pkg.repository?.url !== REPOSITORY_URL) {
    throw new Error("package.json repository.url must exactly match the GitHub repository");
  }
  return pkg;
}

export function checkPack(directory, run = runNpm) {
  const result = run(["pack", "--dry-run", "--json"], directory);
  if (result.status !== 0) throw new Error("npm pack failed; refusing release");
  let pack;
  try { pack = JSON.parse(result.stdout); } catch { throw new Error("npm pack output is unreadable; refusing release"); }
  const files = Array.isArray(pack?.[0]?.files) ? pack[0].files.map(file => file.path) : [];
  if (files.length === 0) throw new Error("npm package content inventory is empty");
  const forbidden = files.filter(path =>
    path.startsWith("native/ce-sqlite/") || path.endsWith(".node") || NATIVE_RELEASE_FILES.has(path)
    || path.startsWith("docs/release/") || path.includes("public-export-ledger")
    || path === "AGENTS.md" || path.startsWith(".herdr-web-ui/"));
  if (forbidden.length > 0) throw new Error(`native release or private files must not enter the npm payload: ${forbidden.join(", ")}`);
  return files;
}

export function assertVersionAbsent(pkg, directory, run = runNpm) {
  const result = run(["view", `${pkg.name}@${pkg.version}`, "version", "--json"], directory);
  if (result.status === 0) throw new Error("version already exists on npm; no overwrite or retry");
  const evidence = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
  if (!/404|not found|e404/.test(evidence)) {
    throw new Error("npm registry version state is unreadable; refusing release");
  }
}

export function preflight({ directory = process.cwd(), expectedSha = process.env.EXPECTED_SHA, actualSha = process.env.GITHUB_SHA, run = runNpm } = {}) {
  assertPublishIdentity({ expectedSha, actualSha });
  const pkg = readPackageMetadata(directory);
  const files = checkPack(directory, run);
  assertVersionAbsent(pkg, directory, run);
  return { name: pkg.name, version: pkg.version, fileCount: files.length };
}

// One attempt, no retry, no dist-tag mutation. OIDC trusted publishing is the
// only supported credential path here.
export function publishOnce({ directory = process.cwd(), env = process.env, run = runNpm } = {}) {
  if (env.NPM_TOKEN) throw new Error("long-lived NPM_TOKEN must not be used; refusing release");
  const result = run(["publish"], directory, env);
  if (result.status !== 0) throw new Error("npm publish failed; no retry and no dist-tag changes");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "preflight") {
      const result = preflight();
      console.log(`preflight passed for ${result.name}@${result.version} (${result.fileCount} files)`);
    } else if (process.argv[2] === "publish") {
      publishOnce();
      console.log("npm publish completed once via trusted publishing");
    } else {
      throw new Error("usage: npm-release.mjs preflight | publish");
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
