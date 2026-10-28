// Release-only orchestration. Importing this module never calls GitHub.
//
// Two credentials are used and never mixed:
//   * the publish credential (GH_TOKEN) performs every version-specific read
//     and every write;
//   * the administration credential (CE_RELEASE_ADMIN_TOKEN) performs only
//     repository-control reads that require repository administration access.
// A child process receives exactly one credential, under GH_TOKEN only.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ADMIN_TOKEN_ENV = "CE_RELEASE_ADMIN_TOKEN";
export const ENVIRONMENT_NAME = "native-sqlite-release";
export const RELEASE_TAG_PREFIX = "ce-sqlite-v";
export const RELEASE_TAG_PATTERN = "refs/tags/ce-sqlite-v*";
export const PUBLISH_REPOSITORY = "zieglar/pi-packages";

function requireToken(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is missing; refusing release`);
  return value.trim();
}

// The publish credential stays the ordinary workflow token. It must never be
// the administration credential, otherwise a read-only precondition read would
// silently become an elevated publish.
export function publishToken(env = process.env) {
  const token = requireToken(env, "GH_TOKEN");
  const admin = env[ADMIN_TOKEN_ENV];
  if (typeof admin === "string" && admin.trim() !== "" && admin.trim() === token) {
    throw new Error("publish credential must differ from the administration credential; refusing release");
  }
  return token;
}

export function adminToken(env = process.env) {
  return requireToken(env, ADMIN_TOKEN_ENV);
}

// Resolves both credentials before any GitHub call, so a missing or
// misconfigured credential refuses before the first request.
export function resolveCredentials(env = process.env) {
  const publish = publishToken(env);
  const admin = adminToken(env);
  if (publish === admin) throw new Error("publish credential must differ from the administration credential; refusing release");
  return { publish, admin };
}

// Child processes receive exactly one GitHub credential. The administration
// secret never reaches a child under its own environment variable name, and
// GITHUB_TOKEN is removed so credential selection cannot be ambiguous.
function childEnv(env, token) {
  const child = { ...env };
  delete child.GITHUB_TOKEN;
  delete child[ADMIN_TOKEN_ENV];
  child.GH_TOKEN = token;
  return child;
}

export function github(args, env = process.env) {
  const child = childEnv(env, env.GH_TOKEN);
  if (typeof child.GH_TOKEN !== "string" || child.GH_TOKEN.trim() === "") {
    throw new Error("GitHub credential missing; refusing release");
  }
  try {
    return { status: 0, stdout: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: child }) };
  } catch (error) {
    return { status: error.status ?? -1, stdout: String(error.stdout ?? "") };
  }
}

// Ordinary publish credential. Used for every version-specific read and every
// write.
export function publishRunner(env = process.env) {
  const token = publishToken(env);
  return args => github(args, childEnv(env, token));
}

// Repository-scoped administration credential. Used only for repository
// control reads that the publish token cannot read.
export function adminRunner(env = process.env) {
  const token = adminToken(env);
  return args => github(args, childEnv(env, token));
}

// Only a real HTTP 404 proves absence. Auth, transport and malformed replies refuse.
export function apiGet(path, run = github) {
  const result = run(["api", "--include", "--method", "GET", path]);
  const matches = [...result.stdout.matchAll(/^HTTP\/\S+ (\d{3})[^\r\n]*\r?$/gm)];
  const header = matches.at(-1);
  if (!header) throw new Error("GitHub API status unavailable; refusing release");
  const status = Number(header[1]);
  const body = result.stdout.slice(header.index).split(/\r?\n\r?\n/).slice(1).join("\n\n");
  let json;
  try { json = JSON.parse(body); } catch { throw new Error("GitHub API response invalid; refusing release"); }
  if (status === 404 && result.status !== 0 && json.message === "Not Found") return undefined;
  if (status !== 200 || result.status !== 0) throw new Error(`GitHub API refused (${status}); no retry`);
  return json;
}

// The release must land in a repository whose immutable-release, tag ruleset
// and environment protections are still in force.
//
// Credential split, verified against the live API:
//   * `GET /repos/{owner}/{repo}/immutable-releases` answers 401 without a
//     credential and 403 for the ordinary publish token, so it needs
//     repository administration read.
//   * The tag ruleset detail exposes its bypass protection fields only in an
//     authenticated response, so the ruleset assertions use the administration
//     credential as well.
//   * The environment and its branch policy are ordinary repository reads, so
//     they keep using the publish credential.
//
// Every read fails closed: a missing credential, a refusal, an unreadable
// answer or a weakened control stops the release before any write.
export function checkRepositoryControls({ repository, environment = ENVIRONMENT_NAME }, deps = {}) {
  const run = deps.run ?? publishRunner();
  const adminRun = deps.adminRun ?? adminRunner();

  const immutable = apiGet(`repos/${repository}/immutable-releases`, adminRun);
  if (immutable?.enabled !== true) throw new Error("repository immutable releases must be enabled by an administrator");

  const rulesets = apiGet(`repos/${repository}/rulesets`, adminRun);
  const tagRulesets = (Array.isArray(rulesets) ? rulesets : []).filter(rule => rule.target === "tag");
  const applicable = [];
  for (const rule of tagRulesets) {
    const detail = apiGet(`repos/${repository}/rulesets/${rule.id}`, adminRun);
    const include = detail?.conditions?.ref_name?.include;
    if (Array.isArray(include) && include.some(pattern => pattern === RELEASE_TAG_PATTERN)) applicable.push(detail);
  }
  if (applicable.length === 0) throw new Error("an active ce-sqlite-v* tag ruleset must protect release tags");
  for (const rule of applicable) {
    if (rule.enforcement !== "active") throw new Error("release tag ruleset must be active");
    const ruleTypes = (rule.rules ?? []).map(entry => entry.type);
    if (!ruleTypes.includes("update") || !ruleTypes.includes("deletion")) {
      throw new Error("release tag ruleset must block tag updates and deletions");
    }
    if ((rule.bypass_actors ?? []).length > 0) throw new Error("release tag ruleset must not allow bypass actors");
    if (rule.current_user_can_bypass === "always") throw new Error("release tag ruleset must not allow bypass");
  }

  const config = apiGet(`repos/${repository}/environments/${environment}`, run);
  if (!config) throw new Error("release environment is missing; refusing release");
  if (config.can_admins_bypass !== false) throw new Error("release environment must not allow administrator bypass");
  if (!Array.isArray(config.protection_rules) || !config.protection_rules.some(rule => rule.type === "branch_policy")) {
    throw new Error("release environment must restrict deployments to protected branches");
  }
  const policies = apiGet(`repos/${repository}/environments/${environment}/deployment-branch-policies`, run);
  const branches = (policies?.branch_policies ?? []).filter(policy => policy.type === "branch").map(policy => policy.name);
  if (branches.length !== 1 || branches[0] !== "main") {
    throw new Error("release environment must deploy from main only");
  }
  return { tagRulesets: applicable.map(rule => rule.id), branches };
}

export function checkRelease({ repository, version, sha, expectedSha }, deps = {}) {
  const run = deps.run ?? publishRunner();
  if (repository !== PUBLISH_REPOSITORY || !/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("invalid release repository/version/commit");
  }
  // The operator states the exact commit they intend to publish. The publish
  // job only accepts a dispatch whose commit is that commit, so an unrelated
  // or newer main head can never be published by accident.
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error("an explicit publish commit SHA is required; refusing release");
  }
  if (expectedSha !== sha) throw new Error("publish commit SHA does not match the dispatched commit; refusing release");
  const tag = `${RELEASE_TAG_PREFIX}${version}`;
  if (apiGet(`repos/${repository}/git/ref/tags/${tag}`, run) !== undefined) throw new Error("version tag already exists; no overwrite");
  if (apiGet(`repos/${repository}/releases/tags/${tag}`, run) !== undefined) throw new Error("version release already exists; no overwrite");
  checkRepositoryControls({ repository }, deps);
  return tag;
}

export function publishRelease(options, assets, deps = {}) {
  const run = deps.run ?? publishRunner();
  const tag = checkRelease(options, deps);
  const expected = ["aarch64-apple-darwin", "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]
    .map(target => `ce-sqlite-${options.version}-${target}.node`)
    .concat(["SHA256SUMS", "native-manifest.json", "native-identities.json", "provenance.jsonl"]).sort();
  if (JSON.stringify(assets.map(asset => basename(asset)).sort()) !== JSON.stringify(expected)) {
    throw new Error("release asset set must match the fixed version inventory");
  }
  const mustRun = args => {
    const result = run(args);
    if (result.status !== 0) throw new Error("release operation failed; retain tag/draft for manual review; no retry");
  };
  // Atomic ref creation refuses a racing tag, instead of binding to someone else's SHA.
  mustRun(["api", "--method", "POST", `repos/${options.repository}/git/refs`,
    "-f", `ref=refs/tags/${tag}`, "-f", `sha=${options.sha}`]);
  mustRun(["release", "create", tag, ...assets, "--repo", options.repository,
    "--verify-tag", "--draft", "--title", `CE SQLite Native ${options.version}`,
    "--notes", `Native assets and provenance bound to ${options.sha}; no replacement or automatic upgrades.`]);
  // Immutable release assets are locked by GitHub when the draft is published.
  mustRun(["release", "edit", tag, "--repo", options.repository, "--draft=false"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {
      repository: process.env.GITHUB_REPOSITORY,
      version: process.env.VERSION,
      sha: process.env.GITHUB_SHA,
      expectedSha: process.env.EXPECTED_SHA,
    };
    if (process.argv[2] === "check") {
      resolveCredentials();
      checkRelease(options);
    } else if (process.argv[2] === "publish") {
      resolveCredentials();
      const directory = resolve(process.argv[3] ?? "release-files");
      publishRelease(options, readdirSync(directory).sort().map(name => `${directory}/${name}`));
    } else throw new Error("usage: native-release.mjs check | publish <verified-assets-directory>");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
