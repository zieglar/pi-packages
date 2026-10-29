[English](operations.md) | [简体中文](operations.zh-CN.md)

# Operations and development

Use [getting started](getting-started.md) for installation and [architecture](architecture.md) for authority and lifecycle details. Operator actions on real transport, credentials, messages and recovery require their own authorization. A documentation or isolated test run does not supply it.

## Security and private state

The extension executes with your user permissions. Masked input protects screen presentation, not against malicious extensions in the same process, recording, clipboard access or memory observation. Never publish credentials, capabilities, message content, complete Session/environment dumps, health URLs or raw logs. Share fixed refusal codes and the minimum non-secret context. Replace private filesystem paths and runtime identifiers with generic placeholders in public reports; configuration keys and protocol fields remain literal.

Profile defaults to `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`. Generated content uses canonical absolute paths. Credential generations under `.credentials/` are private plaintext with 0700 directories / 0600 files. Keep existing credential does not read its contents. Old generations remain; there is no automatic credential/generation GC. `.ce-bindings/` holds bindings/sidecars and Store state, including WAL/SHM and host-secret. Do not merge/copy Stores, reset ownership or hand-edit generated generations, history mappings or release markers.

Executable admission checks ownership/permissions on the original path, symlink targets and all ancestors. It rejects project/`node_modules` paths, writable files/ancestors and untrusted links. On macOS, unknown ACL inspection fails closed; only absent or deny-only ACLs are accepted. A Homebrew installation alone does not establish trust. Use a trusted independent installation and an absolute override rather than loosening permissions or running a refused binary. See [Tunnel diagnostics](tunnel-setup.md).

Storage enforces identity, migration checksums, integrity, leases/fencing and payload authorization. File permissions do not eliminate every filesystem race, mount substitution or crash/power-loss risk. In-memory runtime probes do not establish disk durability. See [Storage security](storage-security.md), [Storage contract](storage-contract.md) and [Ownership contract](ownership-contract.md).

## Diagnose by layer

| Symptom | Check and response |
|---|---|
| Install fails / missing runtime files | Verify approved Node/npm, artifact SHA256 and package payload. Source users build from the repository; consumers use a complete prebuilt artifact, without a build. Do not disable runtime guards or delete Store state. |
| `/ce-tunnel` / `/ce-status` absent | Compare `pi list`, original source and any `-e`; inspect loading refusal codes. Load one copy. Source changes require build before `/reload`. |
| Host / child qualification refusal | `/ce-tunnel doctor` reports each separately. Restart host under approved Node. Repair a canonical saved child command with explicit migrate only after verified STOPPED. `CE_NODE_PATH` cannot repair the running host. |
| Missing/untrusted client | Doctor checks metadata without spawning. Check provenance and the entire permission chain; do not bypass a refused Homebrew ancestor or execute an untrusted binary. |
| `CE_TUNNEL_BACKGROUND_UNAUTHORIZED` | Set exact `CE_TUNNEL_BACKGROUND_ALLOW=1` in the parent Pi environment. Export in a child shell does not change it. |
| Legacy profile rejects registration with `CE_TUNNEL_PROFILE_INVALID` | Explicit `/ce-tunnel convert` creates a multi-session generation after confirmation that old runtimes stopped/updated. This is not an automatic conversion or proof of a transport-state problem. |
| CONNECTED but no messaging / `recipients: []` | Check Advanced Messaging, current Pi binding, current ChatGPT tools, exact Store/Exchange and recipients. Do not resend an original message as a connectivity probe. |
| Send failure / response lost | Retain original key/Message ID. Check `/ce-status`, `/ce-tunnel status`, endpoint and fixed refusal codes. Missing ACK, BUSY, timeout or unknown outcome gives no retry/new-key permission. |
| `CE_HOST_MAPPING_INVALID` / no endpoint | Check real native Session, selected registration, loaded policy and exact release evidence. New/normally released bindings need explicit activate; UNKNOWN is not ordinary unbound state. |
| Read/ACK missing | Check each independent opt-in and explicitly load policy. ACK does not enable payload read. |
| Empty Inbox | Check Store directory/file, Exchange namespace/key and join boundary. A bounded empty page is not proof about the whole Store. Do not copy the database or blindly resend. |
| STARTING / READY_TIMEOUT | Await the in-flight terminal outcome and cleanup evidence; check target/permissions. UNKNOWN does not permit a second instance or unlimited timeout. |
| MANAGER_BUSY / duplicate commands | Check duplicate `pi list`/`-e` loading and close excess UI. Repeated Start is not a fix. |
| Client rejects old `admin_ui` | Verified STOPPED, then `/ce-tunnel migrate`. It repairs canonical schema/child Node without reading the key, changing Store or granting messaging. |
| External instance / lock / STOP_UNCONFIRMED | Preserve state/ledger. Manager Stop acts only on its provably owned instance; other action needs separate operator authority. Do not delete locks or kill by name. |
| Unclean exit leaves a session-process mutex slot | Follow the operator-only offline reconciliation procedure in [Tunnel troubleshooting](tunnel-setup.md). Verify every expected identity and owner-death fact independently. Do not delete locks or probe a real Store with acquire. |

Unknown renew/end or failed mapping persistence blocks further operations. Do not repeat activate/reload to bypass it. Record-backed runs permit at most one SIGTERM; repeated Stop need not resend a signal. UNKNOWN does not mean STOPPED, release or cancellation.

## Recovery and lifecycle

Normal `/ce-tunnel deactivate` releases only the current local CE binding after confirmation; it preserves registration, history and transport. Revoke changes future registration admission and removes no Owner/Participant/message/Receipt. Reload retains valid durable Ownership while replacing the in-memory generation. New/fork Sessions do not inherit authority. Explicit activation uses `requireUnowned` and never takes over an expired or crashed Owner.

Process reconciliation, CE Ownership recovery and unknown-delivery investigation are separate procedures. `recover:ownership` and `reconcile:session-mutex` are operator scripts, not model tools or everyday setup steps. See [explicit stale-ownership recovery](chatgpt-installation.md#显式-stale-ownership-恢复) and the exact CLI contract in [Tunnel troubleshooting](tunnel-setup.md). Do not invent missing arguments, remove unknown flags from a failed command and retry, or treat a receipt as authority to resume business effects.

Mutex reconciliation requires a complete offline maintenance window: stop and prevent restarts of all relevant Pi/CE processes, heartbeats, background launchers, automatic restarts and recovery jobs throughout inspection, reconciliation, persistence and recheck. Independently prove the owner dead. The script accepts exact expected Store/Endpoint/runtime/slot/owner/process/file identities and `--offline-window-confirmed` plus `--owner-death-evidence`; no defaults or `--audit-log` exist, unknown arguments refuse, and it writes no audit file. Check the linked full command and script before use.

Publication first creates `release-pending.json` with O_EXCL, mode 0600 and bytes identical to the owner record. It fsyncs files/directories and rechecks all identities, then atomically renames to `released.json`, the only commit point. Any earlier failure preserves pending state and refuses. If rename throws, only an exact byte/identity match of `released.json` establishes committed success; otherwise stop. No fallible work follows a successful rename. Failures require manual inspection, never retry/overwrite/delete. This reconciles a local mutex receipt, not CE end/detach, takeover or Operator Recovery. Markers are not locks, fencing tokens or exactly-once guarantees.

`DELIVERY_UNKNOWN` remains unknown, never `CANCELLED`. No ACK does not authorize retry. Known delivery with unknown execution does not establish acceptance, settlement or Result. The external workflow or operator owns task/policy/recovery/completion decisions; CE owns message delivery/lifecycle/evidence/reconciliation; Pi owns sessions/runtime/provider transport. Model switching never authorizes replay of effects.

## Uninstall, upgrade and rollback

Follow the full [safe removal procedure](independent-install.md#5-安全卸载升级与回滚). Record the exact source and personal/project scope from `pi list`, package root, versions, profile, Store/Exchange and relevant owned processes. Do not signal by historical PID or filename.

1. Explicitly Stop through the Manager that provably owns the instance; independently verify completed exit and STOPPED. Doctor is not exit proof. UNKNOWN, external ownership or unconfirmed locks/leases stop the procedure.
2. Normally deactivate each affected owned local binding and verify release/detach with `/ce-status`. Do not substitute revoke or recovery. Unknown release or failed evidence persistence stops the procedure.
3. Confirm no other users/Sessions/installations depend on shared resources. Existing commands cannot prove whole-machine non-use. Uncertainty stops removal; do not stop other people's Sessions.
4. Normally exit all relevant owned Pi hosts, including hosts able to load old code. Host exit does not replace transport Stop.
5. Remove the exact original source in its original scope, then inspect `list`:

```sh
"$CE_APPROVED_NODE" "$CE_PI_CLI" remove "npm:@zieglar/pi-chat-exchange@0.2.1"
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
```

Use `--local` if the original installation used it. Directory installations require their original absolute directory source instead of the npm source. Pi native npm remove deletes managed package files before persisting deregistration; do not run an extra rm/npm uninstall against the shared managed root. Local-directory removal deregisters without deleting its directory. Partial remove/persistence failure requires investigation, not blind retry.

Only separately owned, exclusive tarball consumer/dedicated host prefixes with verified absence of dependencies are candidates for later manual deletion. Preserve Store/WAL/SHM/host-secret, profile, credentials, bindings, history and diagnostic evidence by default. Do not purge, clear Owners, delete locks or resend unacknowledged messages.

For upgrade, retain the old exact artifact, SHA256, source, lockfile and configuration locations. Stop/release/exit, remove the old exact source and install the new exact version; tarball users use a new exclusive prefix. After host restart, doctor/status, verify configuration/Store and explicitly activate. Do not automatically Start. Rollback additionally requires confirmed Store/schema/runtime compatibility; unknown compatibility stops downgrade/overwrite/deletion. Reinstalling preserved configuration does not automatically reauthorize a binding.

## Development and contribution

Use approved Node, pnpm 12.9.1 and the frozen workspace lockfile. From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
```

`verify` runs contract/native checks, typecheck, build, default tests and packaged-plugin tests serially. Installed-client, real-host, distribution and native-specific lanes are separate. See [architecture verification layers](architecture.md#验证层次) for their evidence and prerequisites. Do not count a skipped/optional lane as passed or call isolated tests dogfooding. This documentation change does not rerun those gates.

The default test lane selects `node-sqlite` in a private HOME. The Rust lane uses a verified Native cache. Earlier local offline Host runs covered Node22.19.0/24.22.2/25.2.1/25.9.0/26.12.1. [0.2.1 candidate Hosted CI](https://github.com/zieglar/pi-packages/actions/runs/40925049158) passed Linux x64 Native227/227 on Node22.19.0 and24.22.2. See [runtime support](runtime-support.md) for scoped evidence.

Contributions must preserve inward dependency direction, closed schemas, independent payload/ACK grants, trusted Session lookup and final Storage authority. Reuse Host/Storage seams; do not create a second message system. Keep intent before effect, explicit unknown outcomes and normal release paths. New runtime/client/platform support needs its own real qualification. Tests should exercise observable behavior, privacy/refusals, failure evidence and lifecycle boundaries. Do not publish real messages, private paths or Session identifiers as fixtures/evidence. See [architecture](architecture.md) for regression entry points and known debt.

Producer packaging from the repository root:

```sh
pnpm --dir packages/pi-chat-exchange run package:pi-extension
shasum -a 256 packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.2.1.tgz
```

The package command builds and checks the runtime import closure/assets, required native/operations files, absence of consumer lifecycle hooks before `npm pack --ignore-scripts`. Bare `npm pack` bypasses these checks and is not the supported producer command. Desktop packaging uses separate `package:desktop-plugin`; its ZIP is not the Pi npm package.

## Native readiness operations (current source)

Use `/ce-native status` and `/ce-native verify` for read-only local checks. `/ce-native install` explicitly downloads only the trusted default, verifies before changing selection, and requires restarting Pi. Repair requires `/ce-native repair confirm`. `/ce-native check-updates` reads GitHub Release metadata only; `latest` never becomes trusted or changes selection. CE never automatically downloads, repairs or upgrades Native and never falls back.

Extension load is read-only: no downloads, Store creation or Tunnel start. Missing Native leaves Pi and management available with the warning quoted in [Native management](native-management.md); Store, Tunnel start and messaging fail closed. `/ce-tunnel start` revalidates readiness and Store admission before manager/profile/process effects, refusing with a specific `CE_NATIVE_*` code and `/ce-native` hint. Status reports `native=<STATE> (code)` independently of transport and never infers `STOPPED`; stop remains available for safe cleanup.

Windows refuses Native and Tunnel start with `CE_NATIVE_TARGET_UNSUPPORTED`, without attempting a Linux binary. Use Linux Node.js, Pi and CE inside WSL2 to select the real Linux x64/arm64 asset. Keep the active Store on the Linux filesystem rather than `/mnt/c` or other Windows mounts; existing filesystem admission is unchanged. WSL2 integration is unverified here; platform tests cover target mapping and Windows refusal only.

## Release evidence and limits

Published npm0.2.1 requires Node>=22.19.0/Pi1.3.0. [OIDC publish run40925828108](https://github.com/zieglar/pi-packages/actions/runs/40925828108) succeeded at source `c7e2f0f756cd1868f175bde8743cef9920fbc6b8`; Registry integrity/provenance and isolated Registry installation on macOSarm64/Node22.19.0 were verified. Cloud transport remains NOT_VERIFIED. Historical0.2.0 qualification is unchanged.

Native middleware has independent immutable Release `ce-sqlite-v0.1.0`, ABI1, SQLite3.54.1, source `a8386aafd657c84825b2905847f34a43d5b91e1e`. CE0.2.1 includes its verified four-platform pins; Native Store integration covers macOSarm64/Linuxx64, while macOSx64/Linuxarm64 have artifact/conformance only. No automatic download, upgrade, repair or fallback is added. See [Native SQLite](native-sqlite.md) and [Native release CI](native-release-ci.md).

Historical plans/audits retain dated design/test statements. A local commit is not a release, workflow intent is not hosted execution, and a configured publisher is not an OIDC proof. Release/push/publication decisions require separate authorization.

Operational evidence: `pi-extension/index.ts`, `src/runtime/diagnostics.ts`, `src/tunnel/{profile,background-manager,setup,messaging-config}.ts`, `src/storage/{runtime,sqlite-driver-selection,native-compat}.ts`, `scripts/reconcile-session-process-mutex.mjs`, `scripts/recover-stale-ownership.mjs`, `scripts/package-pi-extension.mjs` and `package.json`. Recovery commands must be checked against their scripts before any real execution. This guide supplies no authorization to execute recovery.
