# Rust Native SQLite driver

English | [简体中文](native-sqlite.zh-CN.md)

Current source supports the built-in `node:sqlite` driver and independent Rust Native middleware. Both use the same TypeScript transaction helper, schema v7, SQL algorithms, authorization, idempotency, ACK and recovery contracts. There is no sidecar or IPC. The published npm 0.2.0 artifact and the current source have separate qualification histories; installing npm 0.2.0 does not acquire later source features.

## Release and consumer trust

[Native Release `ce-sqlite-v0.1.0`](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0) is published and immutable. Its middleware version is `0.1.0`, ABI `1`, bundled SQLite `3.54.1`, and exact source SHA `a8386aafd657c84825b2905847f34a43d5b91e1e`. The formal [release workflow run](https://github.com/zieglar/pi-packages/actions/runs/40813628775) succeeded. Published assets were downloaded separately from CI and their checksums, identities and seven subject attestations with source-digest binding verified during release acceptance. That is historical release evidence, not a fresh consumer or runtime test in this documentation change.

**Production asset hashes in `src/storage/native-compat.ts` remain `null`.** A null hash means unpinned and refuses both prepare and load. It does not mean the GitHub Release is absent. Publication, attestation verification and promotion into CE's consumer trust manifest are separate decisions. Native is the target default: absent selection chooses `rust-native` at the declared default version `0.1.0`. `node-sqlite` is an explicitly selected, lazily loaded, nonproduction compatibility driver and is never a fallback. Native load/trust failures fail closed. Production `NATIVE_COMPAT` pins remain null: the default build cannot be released and production is not enabled. Native default and production pins must be delivered as one publish unit, only after separate pin authorization.

The exact eight assets are:

```text
SHA256SUMS
ce-sqlite-0.1.0-aarch64-apple-darwin.node
ce-sqlite-0.1.0-aarch64-unknown-linux-gnu.node
ce-sqlite-0.1.0-x86_64-apple-darwin.node
ce-sqlite-0.1.0-x86_64-unknown-linux-gnu.node
native-identities.json
native-manifest.json
provenance.jsonl
```

The four binaries, checksums and two metadata files are seven attested subjects; `provenance.jsonl` is not self-attested. Native binaries are not part of the npm tarball. Middleware SemVer is independent of the CE npm version.

## Platform evidence

| Target | Native artifact/conformance | Hosted Store integration |
|---|---|---|
| macOS arm64 | Verified in release qualification | Verified |
| Linux x64 GNU | Verified in release qualification | Verified |
| macOS x64 | Verified in release qualification | Not established |
| Linux arm64 GNU | Verified in release qualification | Not established |

The Store allowlist remains macOS arm64 / Linux x64. Artifact qualification on another target does not expand it. The Linux Store evidence does not certify npm 0.2.0 installation, every Pi/client combination, cloud transport or power-loss durability. Local Linux emulation, hosted integration and manual message use are different evidence lanes.

## Driver selection

Both Pi Host and MCP child read `~/.config/pi-chat-exchange/sqlite-driver.json`. Absent selection chooses `rust-native` at `NATIVE_COMPAT.defaultVersion` (`0.1.0`). Explicit selection is not inferred from PATH, the working directory or a caller-supplied version. Node is never a fallback.

```json
{
  "version": 1,
  "driver": "rust-native",
  "nativeVersion": "0.1.0",
  "manifestFile": "/absolute/path/to/verified-native-manifest.json"
}
```

`manifestFile` is optional; without it the package's `NATIVE_COMPAT` applies and its current null hashes refuse loading. An operator-supplied manifest pins middleware version, ABI, target asset and SHA-256, and is executable-code trust authority. Verify its origin independently. A checksum downloaded beside an untrusted binary is insufficient as the sole trust anchor. Do not use `latest`, automatic upgrades or unverified pins.

## Prepare, select and inspect

These commands apply to a built current-source checkout, from the package directory after `pnpm run build`. They are conditional operator procedures, not an enabled default installation path: first obtain an independently verified manifest and authorize its use.

First set `CE_NATIVE_TEST_HOME` to the absolute path of a private isolated HOME prepared for this qualification and populate its verified cache. Use that same HOME throughout; this example supplies no authority over the production HOME.

```sh
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js prepare \
  --version 0.1.0 \
  --manifest /absolute/path/to/verified-native-manifest.json
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js select --driver rust-native \
  --version 0.1.0 \
  --manifest /absolute/path/to/verified-native-manifest.json
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js status
```

`prepare` is explicitly network-capable. It downloads the fixed target asset, checks SHA-256 in a private temporary file and atomically installs a versioned cache entry. It does not run install scripts, compile on the consumer, overwrite another version or expose a partial loadable file. Concurrent preparation does not replace a valid existing entry. The default download URL is `https://github.com/zieglar/pi-packages/releases/download/ce-sqlite-v<version>/<asset>`.

`select` verifies the cached artifact before persisting selection. `status` is offline and reports the selected driver, target, cache root, module/SQLite identity or a closed error code. For explicit nonproduction Node compatibility, stop every Store user first, then explicitly run:

```sh
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js select --driver node-sqlite
```

`select` uses the selected HOME's runtime cache. A custom `--root` is for explicit prepare/status qualification only; select rejects it. Manifest paths are persisted as absolute paths.

```text
~/.config/pi-chat-exchange/native/
  ce-sqlite/<version>/<target>/<asset>
  ce-sqlite/<version>/<target>/artifact.json
```

## Verification and failure boundaries

Runtime loading checks the cache directory chain for symlinks, ownership and group/other write access. It then checks file ownership/mode, SHA-256, middleware SemVer, ABI and target before `require()`. Missing or incompatible artifacts fail closed. Verification and `dlopen` are separate operations; replacement by the same OS user is outside the claimed boundary.

Rust admission checks the actual module, Node-API >= 8, SQLite identity, compile options and shared behavior probes. It uses bundled SQLite 3.54.1 independently of `process.versions.sqlite`, retaining the >=3.51.3 safety floor. Node keeps its own version and known-defect rules. Shared conformance covers statements, transactions, authorizer/defensive mode, extended errors, BLOB, NULL, changes and closed-state handling. Rust prepares/finalizes statements per operation and does not re-enter JavaScript from the authorizer. A panic or native memory fault can still terminate the host.

Use exactly one SQLite implementation per live database within a process. Node and Native contain separate SQLite libraries; opening/closing the same database through both on POSIX can release process-owned locks. Switch only after stopping every process using the Store. Cross-driver tests close connections between implementations.

Unknown commit/close outcomes are not rollback proof and are never automatically retried. Recovery markers are not locks or fencing tokens. See [storage security](storage-security.md), [runtime qualification](runtime-support.md) and [release operations](operations.md). Release workflow details are in [Native release CI](native-release-ci.md).
