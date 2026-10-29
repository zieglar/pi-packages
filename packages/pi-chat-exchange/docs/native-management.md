# Native driver management

English | [简体中文](native-management.zh-CN.md)

This guide covers the Native readiness and management features included in `@zieglar/pi-chat-exchange@0.2.1`, with Node `>=22.19.0` and Pi `1.3.0`. Historical npm `0.2.0` retains its Node `24.21.0` qualification, Node `24.21.0/24.22.1` engines, Pi `1.3.0`, macOS arm64 and cloud `NOT_VERIFIED` boundary. Installing 0.2.0 does not acquire the 0.2.1 features.

## Trusted default

Rust Native is the only default persistence driver. Without a selection file, CE selects `rust-native` `0.1.0`. `node:sqlite` (`node-sqlite`) remains an explicit non-production compatibility selection, with no automatic fallback. Native readiness reports that selection as `INCOMPATIBLE` (`CE_NATIVE_DRIVER_INCOMPATIBLE`); it does not enable production messaging.

Production `NATIVE_COMPAT` pins [ce-sqlite-v0.1.0](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0), immutable Release `427441708`, source `a8386aafd657c84825b2905847f34a43d5b91e1e`, ABI `1`, bundled SQLite `3.54.1`. The four platform SHA-256 values were verified against `SHA256SUMS`; seven attestation subjects were verified as bound to that source. This is recorded release acceptance evidence, not a new network verification in this documentation update. Binaries are separate from the npm tarball.

CE never automatically downloads, repairs or upgrades Native. There is no implicit fallback. Release discovery never grants trust to a new version.

## Commands in Pi

| Command | Effect |
|---|---|
| `/ce-native` or `/ce-native status` | Read-only local readiness inspection |
| `/ce-native verify` | Read-only local verification; no download or selection change |
| `/ce-native install` | Explicit download of only the trusted default version; verify before changing selection |
| `/ce-native repair confirm` | Explicit repair through the same trusted preparation and selection path |
| `/ce-native check-updates` | Read-only GitHub Release discovery; no installation or selection change |

Start with `/ce-native status`. If installation is needed, explicitly run `/ce-native install`, then restart Pi before setup or messaging. Installation selects only after artifact verification. Repair requires the literal `repair confirm`; bare `repair` does not authorize it. A hash-corrupted regular cache file is replaced atomically only after the download passes the fixed trust pin; failed downloads preserve the old file and selection. Unsafe paths, ownership or permissions are refused and need operator inspection. Do not delete Store or ownership files to repair a driver.

`check-updates` makes a network request for GitHub Release metadata. `latest` is discovery only and is never treated as trusted. A different discovered release requires a CE compatibility update; the command never changes the selected driver. `status` and `verify` are offline. Verification can load the local module to inspect its identity; read-only does not mean that native code is never loaded.

Selection is stored in `~/.config/pi-chat-exchange/sqlite-driver.json`; the versioned cache is under `~/.config/pi-chat-exchange/native/`. Advanced isolated CLI qualification is documented in [Native SQLite](native-sqlite.md). Stop all Store users before switching SQLite implementations; use one implementation per live database within a process.

## Readiness and extension load

Extension load is read-only: it never downloads, creates a Store or starts Tunnel. When Native is not ready, Pi still loads and management commands stay available. The session warning is:

```text
Chat Exchange: Native Driver is not ready. Messaging is disabled. Run /ce-native to inspect or install the trusted driver.
```

The warning is emitted at most once per extension instance, so it is not repeated per event, message or command. `test/tunnel/native-command.test.ts` covers that the same instance warns only once. After the operator installs the trusted driver and restarts Pi, the next instance loads silently.

Without ready Native, Store, Tunnel start and messaging fail closed. Inspection returns a state and a specific code; preserve the code when diagnosing a refusal.

| State | Meaning or example code |
|---|---|
| `READY` | Verified module available (`CE_NATIVE_READY`); Tunnel start still checks Store admission |
| `MISSING` | Trusted cache entry absent (`CE_NATIVE_CACHE_MISSING`) |
| `UNTRUSTED` | Artifact or cache trust verification failed, for example `CE_NATIVE_HASH_MISMATCH` |
| `INCOMPATIBLE` | Selected driver or Native identity incompatible, for example `CE_NATIVE_DRIVER_INCOMPATIBLE` |
| `INITIALIZATION_FAILED` | Module initialization failed, for example `CE_NATIVE_INITIALIZATION_FAILED` |
| `UNSUPPORTED_PLATFORM` | Unsupported platform or architecture (`CE_NATIVE_TARGET_UNSUPPORTED`) |

`/ce-tunnel start` revalidates Native readiness and the Store admission battery before any manager, profile or process effect. It refuses with a specific `CE_NATIVE_*` code and a `/ce-native` hint. `/ce-tunnel status` reports `native=<STATE> (code)` separately from transport lifecycle; unavailable Native never establishes `STOPPED`. `/ce-tunnel stop` remains the safe cleanup path and is not blocked by missing Native. Other ownership and process-identity safeguards still apply.

## Windows and WSL2

Windows Native is unsupported (`CE_NATIVE_TARGET_UNSUPPORTED`). No Windows Native binary exists, CE never tries to load Linux binaries on Windows, and `/ce-tunnel start` refuses.

The recommended Windows path is Linux Node.js, Pi and CE inside WSL2. Asset selection uses the real platform and architecture: Linux x64 selects `x86_64-unknown-linux-gnu`, Linux arm64 selects `aarch64-unknown-linux-gnu`. Keep an active SQLite Store on the Linux filesystem rather than `/mnt/c` or other Windows mounts. This recommendation adds no filesystem restrictions; existing Store admission remains in force and artifact availability does not expand the Store allowlist.

WSL2 integration was not verified in this environment. Platform tests cover target mapping and Windows refusal only. Node `>=22.19.0` follows the installed Pi `1.3.0` Host manifest; it does not qualify every later Node build. See [runtime support](runtime-support.md) for platform and test evidence, and [operations](operations.md) for safe cleanup and release boundaries.
