// Release-only orchestration. Importing this module never calls GitHub.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function github(args) {
  try {
    return { status: 0, stdout: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { status: error.status ?? -1, stdout: String(error.stdout ?? "") };
  }
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

export function checkRelease({ repository, version, sha }, run = github) {
  if (repository !== "zieglar/pi-packages" || !/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("invalid release repository/version/commit");
  }
  const tag = `ce-sqlite-v${version}`;
  if (apiGet(`repos/${repository}/git/ref/tags/${tag}`, run) !== undefined) throw new Error("version tag already exists; no overwrite");
  if (apiGet(`repos/${repository}/releases/tags/${tag}`, run) !== undefined) throw new Error("version release already exists; no overwrite");
  const immutable = apiGet(`repos/${repository}/immutable-releases`, run);
  if (immutable?.enabled !== true) throw new Error("repository immutable releases must be enabled by an administrator");
  return tag;
}

export function publishRelease(options, assets, run = github) {
  const tag = checkRelease(options, run);
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
    const options = { repository: process.env.GITHUB_REPOSITORY, version: process.env.VERSION, sha: process.env.GITHUB_SHA };
    if (process.argv[2] === "check") checkRelease(options);
    else if (process.argv[2] === "publish") {
      const directory = resolve(process.argv[3] ?? "release-files");
      publishRelease(options, readdirSync(directory).sort().map(name => `${directory}/${name}`));
    } else throw new Error("usage: native-release.mjs check | publish <verified-assets-directory>");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
