// Pre-publication verification of the attested release set.
// This module never writes to the repository and never accepts a credential
// on the command line.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];

// The signed bundle itself is not a subject of its own attestation.
export const ATTESTED_SUBJECTS = ["SHA256SUMS", "native-identities.json", "native-manifest.json"];

export function expectedInventory(version) {
  return TARGETS.map(target => `ce-sqlite-${version}-${target}.node`)
    .concat(["SHA256SUMS", "native-manifest.json", "native-identities.json", "provenance.jsonl"]).sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Verifies that the bundle holds exactly the fixed inventory, that SHA256SUMS
// describes exactly the four Native binaries, and that every recorded digest
// matches the bytes on disk.
export function verifyChecksums(directory, version) {
  const names = readdirSync(directory).sort();
  const expected = expectedInventory(version);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("release bundle must contain exactly the fixed eight-file inventory");
  }
  const binaries = TARGETS.map(target => `ce-sqlite-${version}-${target}.node`).sort();
  const recorded = readFileSync(resolve(directory, "SHA256SUMS"), "utf8").split("\n").filter(Boolean);
  if (recorded.length !== binaries.length) throw new Error("SHA256SUMS must list exactly the four Native binaries");
  for (const line of recorded) {
    const match = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    if (!match) throw new Error("SHA256SUMS entry is malformed");
    const [, digest, name] = match;
    if (!binaries.includes(name)) throw new Error("SHA256SUMS lists a file outside the fixed inventory");
    const actual = sha256(readFileSync(resolve(directory, name)));
    if (actual !== digest) throw new Error(`checksum mismatch for ${name}; refusing publication`);
  }
  for (const name of binaries) {
    if (!recorded.some(line => line.endsWith(`  ${name}`))) throw new Error(`SHA256SUMS does not cover ${name}`);
  }
  return recorded.length;
}

// Verifies every signed subject against the published bundle, bound to the
// repository, signer workflow, source ref and exact source commit.
export function verifyAttestations({ directory, repository, sha, sourceRef = "refs/heads/main", signerWorkflow }, run = github) {
  const names = readdirSync(directory).sort()
    .filter(name => name.endsWith(".node") || ATTESTED_SUBJECTS.includes(name));
  if (names.length !== 7) throw new Error("expected seven attested release subjects");
  for (const name of names) {
    const result = run(["attestation", "verify", name, "--repo", repository,
      "--bundle", "provenance.jsonl", "--source-digest", sha, "--source-ref", sourceRef,
      "--signer-workflow", signerWorkflow], resolve(directory));
    if (result.status !== 0) throw new Error(`attestation verification failed for ${name}; refusing publication`);
  }
  return names;
}

export function github(args, cwd = process.cwd()) {
  try {
    return { status: 0, stdout: execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }) };
  } catch (error) {
    return { status: error.status ?? -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

export function verifyReleaseSet(options) {
  const { directory, version, repository, sha } = options;
  const checksums = verifyChecksums(directory, version);
  const subjects = verifyAttestations({
    directory, repository, sha,
    signerWorkflow: options.signerWorkflow ?? `${repository}/.github/workflows/native-release.yml`,
  }, options.run);
  return { checksums, subjects };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {
      directory: resolve(process.argv[2] ?? "release-files"),
      version: process.env.VERSION,
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA,
    };
    if (!options.version || !options.repository || !options.sha) {
      throw new Error("VERSION, GITHUB_REPOSITORY and GITHUB_SHA are required");
    }
    const result = verifyReleaseSet(options);
    console.log(`verified ${result.checksums} checksums and ${result.subjects.length} attestation subjects`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
