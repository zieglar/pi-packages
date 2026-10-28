# Rust Native SQLite Driver

This package can use either the built-in `node:sqlite` driver or the independent Rust Native middleware. The TypeScript transaction helper, schema v7, SQL algorithms, authorization, idempotency, ACK and recovery contracts stay the same. There is no Sidecar or IPC.

## Driver selection

The default remains `node-sqlite`; selecting Rust never silently falls back to it. Selection is read from `~/.config/pi-chat-exchange/sqlite-driver.json` by both the Pi Host and MCP child. It is not inferred from PATH, a working directory or a caller-supplied Node version.

```json
{
  "version": 1,
  "driver": "rust-native",
  "nativeVersion": "0.1.0",
  "manifestFile": "/absolute/path/to/verified-native-manifest.json"
}
```

`manifestFile` is optional. Without it, the package's `NATIVE_COMPAT` is used. The manifest pins ABI, middleware SemVer, target asset and SHA-256. A missing hash (`null`) means unpublished/unpinned and refuses both prepare and load. Do not use `latest`, automatic upgrades or an unverified new artifact.

A missing Native cache or an incompatible artifact is a hard failure; it never causes an implicit `node:sqlite` fallback.

## Prepare (explicit, network-capable command)

After building the package (`pnpm run build`):

```sh
node dist/bin/ce-native.js prepare \
  --version 0.1.0 \
  --manifest /absolute/path/to/verified-native-manifest.json
```

Prepare downloads only the fixed asset selected by the manifest and current target, writes a private temporary file, checks SHA-256, then atomically installs it into the versioned cache. It does not run install scripts, compile on the consumer, overwrite another version or leave a loadable partial file. Concurrent preparation never replaces a good existing cache entry.

The default source is `https://github.com/zieglar/pi-packages/releases/download/ce-sqlite-v<version>/<asset>`. Local fixtures may be used only by tests; real GitHub Releases distribution is **not verified by this development change**.

## Select and inspect

Only after the artifact is cached and verified:

```sh
node dist/bin/ce-native.js select --driver rust-native \
  --version 0.1.0 \
  --manifest /absolute/path/to/verified-native-manifest.json
node dist/bin/ce-native.js status
```

`select` verifies the artifact before writing the selection. `status` is offline and reports the selected driver, target, cache root, reported middleware/SQLite identity, or a closed error code. To return to the built-in driver, explicitly select `node-sqlite`.

`select` uses the runtime cache under the selected HOME. A custom `--root` is supported for explicit prepare/status qualification only and is rejected by select. Manifest paths are saved as absolute paths; treat an operator-supplied manifest as executable-code trust authority. Obtain its pins through an independently verified channel.

Cache layout:

```text
~/.config/pi-chat-exchange/native/
  ce-sqlite/<version>/<target>/<asset>
  ce-sqlite/<version>/<target>/artifact.json
```

Runtime loading checks the complete cache directory chain for symlinks, ownership and group/other write access, then rechecks file ownership/mode, SHA-256, middleware SemVer, ABI and target before `require()`. A hash mismatch, ABI mismatch, target mismatch or malformed module report refuses loading. Verification and `dlopen` are separate operations; equivalent-UID replacement of the path is outside the claimed security boundary.

## Independent middleware version and release

Rust middleware has its own SemVer, independent of the CE npm version. ABI is currently `1`. CE declares compatible middleware versions and exact asset hashes in `src/storage/native-compat.ts` or an operator-supplied manifest. Native binaries are **not** included in the npm package.

`.github/workflows/native-release.yml` builds the declared targets, runs conformance, records middleware/SQLite/target/build identity and generates asset hashes. Release creation is a separate `environment: native-sqlite-release` action and requires an explicit publish input. The workflow itself does not publish a tag or release on an ordinary build.

Current declared build matrix: macOS arm64, macOS x64, Linux x64 GNU, Linux arm64 GNU. Local verification covers macOS arm64 and Linux x64 under Docker emulation on an arm64 host. Linux x64 evidence covers the adapter, subprocess locking and SIGKILL recovery; it does not claim a full CE Store/Pi acceptance run. macOS x64 and Linux arm64 remain build targets only.

The CE Store admission policy still allows only macOS arm64 and Linux x64. Other listed targets are artifact build/conformance targets; they do not expand Store support. Hosted CI and actual GitHub release download remain unverified until the separately authorized workflow runs.

## Database connection ownership

Use exactly one SQLite implementation for a given live database within a process. Node and the Native addon contain separate SQLite libraries. On POSIX, opening/closing the same database through both libraries can release process-owned locks while the other library still believes it owns them. All CE connections, snapshots and validation use the selected driver. Cross-driver persistence tests close the old connections before opening the other implementation; switch drivers only after stopping every process using the Store.

## Runtime qualification and failure boundaries

- Node driver retains its existing Node-version and known-defect qualification rules.
- Rust checks the actual cached module, Node-API >= 8, SQLite version/source, compile options and behavior, not a Node built-in SQLite version whitelist.
- Bundled SQLite is used, not the system SQLite. The current build reports SQLite 3.54.1 and preserves the >=3.51.3 safety floor.
- `prepare/get/all/run/exec`, transactions, authorizer policy, defensive mode, extended SQLite errors, BLOB, NULL, changes and closed-state classification are covered by shared conformance.
- Rust statements are prepared per operation and finalized in that call; no Rust statement pointer escapes. Node retains its own statement lifecycle. Both wrappers refuse statement execution after connection close; transaction wrappers also revoke statements when the callback ends.
- No JavaScript is re-entered from the SQLite authorizer. The parsed policy is implemented in Rust.
- Unknown commit/close outcomes are never automatically retried. A Native panic or memory fault can still terminate the host; Rust `Result` mapping does not make that a rollback proof.
- Actual GitHub Releases distribution has not been verified. SHA-256 is anchored in the CE compatibility manifest, not in a checksum downloaded from the same untrusted location as the binary.
