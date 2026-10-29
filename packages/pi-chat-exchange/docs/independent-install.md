[English](independent-install.md) | [简体中文](independent-install.zh-CN.md)

<a id="独立安装-pi-扩展020managed-npm-与-tarball-回退"></a>

# Independent Host and tarball installation (0.2.1)

For an existing Pi installation, use [Getting started](getting-started.md). This alternative installs a dedicated Pi 1.3.0 Host. Use Node **>=22.19.0** on **macOS arm64 / Linux x64 GNU**, with a filesystem accepted by the Store. The published package is `@zieglar/pi-chat-exchange@0.2.1`; source builds are covered in [operations](operations.md).

## Current 0.2.1: dedicated Host

Run in a system terminal under a trusted supported Node/npm. Use a new directory if `~/ce-install/host` already serves another installation. The Node placeholder must be replaced before execution; put the same Node installation first in PATH for npm.

```sh
CE_APPROVED_NODE=/absolute/path/to/approved/node
node --version
npm --version
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
CE_PI_CLI="$HOME/ce-install/host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
export npm_config_ignore_scripts=true
"$CE_APPROVED_NODE" "$CE_PI_CLI" install npm:@zieglar/pi-chat-exchange@0.2.1
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
"$CE_APPROVED_NODE" "$CE_PI_CLI"
```

Success: Pi lists the exact0.2.1 source. Continue [Native preparation and first exchange](getting-started.md#4-prepare-native), using this Host entrypoint wherever that guide says `pi`. `/ce-native install` requires a full Pi restart. Configure parent executable paths/background opt-in before launching Pi; no automatic Tunnel Start occurs.

## Current 0.2.1: Registry tarball alternative

Obtain the exact published archive from `https://registry.npmjs.org/@zieglar/pi-chat-exchange/-/pi-chat-exchange-0.2.1.tgz`. The release-verified SHA256 is `786ba02ebb4e20631bcbfba571a10d1d7ee2b3215118c1259778eedbf36c406f`. Verify before installing; a mismatch stops the procedure. Use a new operator-owned consumer directory.

```sh
shasum -a 256 ~/ce-install/zieglar-pi-chat-exchange-0.2.1.tgz
npm install --prefix ~/ce-install/consumer --omit=dev --ignore-scripts --save-exact \
  ~/ce-install/zieglar-pi-chat-exchange-0.2.1.tgz
"$CE_APPROVED_NODE" "$CE_PI_CLI" install "$HOME/ce-install/consumer/node_modules/@zieglar/pi-chat-exchange"
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
```

Success: the physical package manifest reports0.2.1 and Pi lists that exact directory. Directory registration does not install dependencies; npm must finish first. Do not pass the tarball URL to Pi (URLs are Git sources), mix this route with managed npm, or load another `-e` copy. Native is downloaded only by explicit preparation and is not bundled in the archive.

Actual Registry0.2.1 install/load/first-run/persistence passed on isolated Pi1.3.0/Node22.19.0/macOSarm64. [Publication](https://github.com/zieglar/pi-packages/actions/runs/40925828108) and [Linux x64 Native CI](https://github.com/zieglar/pi-packages/actions/runs/40925049158) are separate evidence. Real Cloud exchange remains unverified.

For removal, record the actual source from `pi list` and use the [safe removal procedure](#5-safe-uninstall-upgrade-and-rollback). Its legacy0.2.0 command is only an example for that old installation: remove the exact recorded source (0.2.1 for a current managed install), not an assumed version.

## Historical 0.2.0 installation and qualification record

The remainder preserves0.2.0 commands, runtime restrictions and acceptance evidence. They are historical examples, not the current installation baseline. Older candidate experiments mentioned there are also historical; current Native runtime requirements are above. Do not run the old producer commands against a0.2.1 checkout expecting a0.2.0 artifact.


Development candidate notice: the historical 0.2.0 instructions and certification below describe the unchanged published artifact. A locally built candidate declares Node `>=24.20.0 <=24.22.2` and requires SQLite >=3.51.3, platform/compile safety and shared behavioral checks; exact SQLite/source equality is removed. Node 24.19.0/25.9.0 are refused after reproduced native crashes; 26.12.1 is preview only. Candidate tests use isolated Stores and real Pi 1.3.0 on macOS arm64. Do not apply these candidate claims to npm 0.2.0.

`@zieglar/pi-chat-exchange@0.2.0` is published on npm. Install the exact published version through managed npm, or obtain a prebuilt npm tarball, install it physically and register it with Pi. Consumers need no repository, TypeScript, pnpm, tsconfig or build. These paths serve different purposes:

| Path | Purpose | Difference |
|---|---|---|
| **This guide (managed npm/tarball)** | Distribution for daily use | Prebuilt runtime closure; no consumer build |
| Repository source build + `pi install <directory>` | Developer/Dogfood | References a development-tree directory; see [README](../README.md) |
| Desktop plugin ZIP | ChatGPT Desktop stdio MCP | Separate packaging script; see [ChatGPT installation](chatgpt-installation.md) |

Package version is **0.2.0**. The owner licensed CE-owned code under MIT (Copyright (c) 2026 zieglar; see bundled LICENSE). Third-party license evidence was closed and `private: true` removed from the manifest under the owner's conditions.

For native managed npm, install independent Pi 1.3.0 and select approved Node/npm below, then run `"$CE_APPROVED_NODE" "$CE_PI_CLI" install npm:@zieglar/pi-chat-exchange@0.2.0`. Pi physically installs dependencies into its scoped npm root. Do not add a separate consumer directory or second `-e` load. Historical 0.2.0 command acceptance used an isolated loopback test registry; publication on public npm is a separate fact and does not extend that acceptance to cloud transport. Confirm exact-version resolution in your trusted registry.

The tarball below is a separate asset fallback: obtain a prebuilt `.tgz` from a publisher-provided GitHub release asset or secure private delivery and verify SHA256 before physical installation. Do not pass an asset URL directly to Pi (URLs are Git sources) or treat the monorepo Git source as this package's npm installation. Source development still references the development tree.

<a id="0-消费者前提"></a>

## 0. Consumer prerequisites

| Component | Requirement |
|---|---|
| Node (published 0.2.0) | Exactly **24.21.0 or 24.22.1**, installed locally; mise is optional. Pi host and MCP child independently pass the original SQLite/runtime qualification gates. See the candidate notice above for local development |
| npm | 11.x distributed with approved Node |
| Pi | **1.3.0**, with a `pi` executable from global installation or local prefix |
| Platform | macOS arm64 (Store allowlist; Linux x64 was not accepted through this installation path) |
| Tunnel client | Optional. Without it, `/ce-tunnel doctor` safely refuses with diagnostics such as `CE_EXECUTABLE_UNTRUSTED`/missing. This is expected, not installation failure or compatibility evidence |

No repository clone, pnpm, TypeScript or consumer build/lifecycle scripts are needed. The package has no install hooks; use `--ignore-scripts` throughout.

0.2.0's qualification target was only **Node 24.21.0 + Pi 1.3.0 + macOS arm64**. 24.22.1 was already runtime-approved but outside that qualification. Linux was unverified through this path; cloud remains NOT_VERIFIED.

The package manager must also use approved Node. Put its bin directory first in PATH and check `node --version` is v24.21.0 and `npm --version` is its bundled 11.x. Do not borrow a different global npm/Node. Use operator-controlled npm userconfig/globalconfig/cache, set `npm_config_ignore_scripts=true` and do not inherit tokens from another registry. Explicit registry downloads are needed only during installation, not runtime. This package requires no consumer build or lifecycle hooks.

<a id="1-生产者作者侧仅作者执行一次"></a>

## 1. Producer steps (author only)

Build and package in the complete workspace after installing frozen dependencies as described in the [README](../README.md).

```sh
# 仓库根目录，批准 Node 24.21.0/24.22.1 + pnpm 12.9.1
node --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run package:pi-extension
# 产物：packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.2.0.tgz
# 可选自定义输出目录：node packages/pi-chat-exchange/scripts/package-pi-extension.mjs /path/to/out
```

The command builds with `tsc`, validates payloads (local runtime import closure, `new URL` runtime assets, required native/operational scripts, no consumer lifecycle hook), then revalidates the native manifest before `npm pack --ignore-scripts`. Missing items fail closed. **Bare `npm pack` is not the supported author command**: the `files` allowlist now includes `dist/`, but bare pack skips payload/closure/manifest checks and does not produce the traceable artifact SHA.

Record the hash and deliver it alongside the tarball through the chosen trusted channel:

```sh
shasum -a 256 packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.2.0.tgz
```

Consumers must not rebuild or modify the tarball. A new artifact requires the producer steps.

<a id="2-消费者物理安装-tarball-与-pi-本体"></a>

## 2. Consumer: physically install the tarball and Pi

Place the tarball in a consumer-controlled directory (here `~/ce-install`; paths containing spaces and scoped `node_modules/@scope` are supported):

```sh
# 本地 consumer 根：安装私有包及其运行时依赖（全部物理落盘，无 symlink 外链）
npm install --prefix ~/ce-install/consumer --omit=dev --ignore-scripts --save-exact \
  ~/ce-install/zieglar-pi-chat-exchange-0.2.0.tgz

# 独立 Pi 本体（本指南必需，即使已有全局 Pi；同样禁用 lifecycle scripts）
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
```

Optionally inspect the compiled runtime and local entrypoints:

```sh
tar tzf ~/ce-install/zieglar-pi-chat-exchange-0.2.0.tgz | sort
# 必须看到 package/LICENSE、package/pi-extension/index.ts、package/dist/bin/mcp-stdio.js、
# package/dist/tunnel/multi-session-policy.js、package/native/tunnel-keychain.swift、
# package/scripts/recover-stale-ownership.mjs、package/scripts/reconcile-session-process-mutex.mjs
```

<a id="3-消费者注册到-pi-并验证"></a>

## 3. Consumer: register with Pi and verify

```sh
# 填入本机批准 Node 的绝对路径（不是任意 PATH 中的 node）
CE_APPROVED_NODE=/absolute/path/to/approved/node
CE_PI_CLI="$HOME/ce-install/host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
"$CE_APPROVED_NODE" --version  # 必须精确为 v24.21.0 或 v24.22.1
"$CE_APPROVED_NODE" "$CE_PI_CLI" install ~/ce-install/consumer/node_modules/@zieglar/pi-chat-exchange
"$CE_APPROVED_NODE" "$CE_PI_CLI" list   # 应列出上述物理安装目录
```

For a local-directory source, `pi install` registers an already physically installed package; it does not install dependencies. Do not load a second copy with `-e`. Prefix npm installation places Pi's bin link at `host/node_modules/.bin/pi`, not `host/bin/pi`. Use `"$CE_APPROVED_NODE" "$CE_PI_CLI"` for the Pi commands below (no subcommand starts the TUI), avoiding a shebang selecting unapproved PATH Node or another global Pi. Host and MCP child independently require qualification diagnostics. This installation path was tested on Node 24.21.0; approved 24.22.1 was not part of that installation test.

First run, from the working directory in the interactive Pi TUI, with explicit confirmations:

```text
/ce-tunnel doctor        # 只读资格诊断；client 未装 → 安全拒绝是预期，不算失败
/ce-tunnel setup         # Tunnel ID → Organization(可空) → masked API key → Advanced ·
                         #   Messaging 授权本 Session → Review → Confirm → Save
/ce-tunnel convert       # 转为 multi-session；保留当前 native Session 的原 endpoint
/new                     # 若要登记不同 endpoint，必须先新建 native Session
/ce-tunnel register pi/distribution  # 为新 Session 登记不同的稳定 endpoint；不启动传输
/reload                  # 载入新 policy（首 reload 可能报 mapping 拒绝，随后显式 activate）
/ce-tunnel activate      # 确认框默认 Cancel，必须下移选择 "Activate current session"
/ce-status
/ce-tunnel deactivate    # 正常释放本 Session 绑定；登记与历史保留
```

The last `/ce-tunnel deactivate` demonstrates normal unbinding; it is not a prerequisite for sending. For first-message verification, keep the authorized binding and defer that line, or explicitly reactivate if already deactivated. Installation does not prove cloud availability. Under separate authorization, follow [two-way Tunnel message verification](tunnel-setup.md#4-双向-send--inbox--read--ack) for client/ChatGPT connection, explicit Start and independent read/ACK. Offline synthetic flows are not real cloud acceptance.

`convert` neither clears nor renames the original registration. To reuse the same Session/endpoint, omit `/new` and registration of a different endpoint, then reload/activate. Registering another endpoint for the same native Session refuses. The tested sequence above uses `/new` and `pi/distribution` while retaining the original registration.

`CE_TUNNEL_PROFILE` selects a normalized absolute profile file, not a directory. Setup writes credentials into `.credentials/` beside that file (defaults in the [Tunnel guide](tunnel-setup.md#配置模型与生成文件)). Credentials use owner-only files (0600, directory 0700), never plaintext in the profile. Configured ≠ Pi-bound ≠ Connected. Real Tunnel startup still requires `CE_TUNNEL_BACKGROUND_ALLOW=1` and explicit `/ce-tunnel start`; see the [Tunnel user guide](tunnel-setup.md).

See the [multi-session guide](multi-session-usage.md) for registration, unbinding and revocation.

<a id="本指南已验证的范围与未验证项"></a>

### Verified scope and unverified items

The first-run sequence was tested with real installation, independent Pi 1.3.0 and a real PTY through installation, Host load, first save, conversion, registration, activation, deactivation and persisted state (profile/credential permissions, policy registration, mutex release and synthetic Store mode). The environment was **offline synthetic mode**, with `PI_OFFLINE=1` and no real Tunnel client. Doctor's `CE_EXECUTABLE_UNTRUSTED` refusal was expected, not compatibility/readiness evidence. **Real cloud transport (CLOUD_TRANSPORT) was not verified**. A trusted client, `CE_TUNNEL_BACKGROUND_ALLOW=1` and explicit `/ce-tunnel start` are separate requirements outside this guide's tested scope.

<a id="4-信任与安全注意"></a>

## 4. Trust and safety

- Pi extensions run with your full user permissions. Review source/artifact provenance before installation. `--ignore-scripts` restricts installation scripts, not extension runtime permissions.
- For tarball delivery, verify SHA256 and optionally inspect `tar tzf` using the required-file list above. Published exact npm installation is also available.
- Use `--ignore-scripts` throughout. The package has no need for install/prepack/prepare hooks.
- The installed dependency tree must physically reside within the consumer prefix. Internal bin symlinks are normal; links outside it or into the development tree are not.
- Desktop ZIP is a separate path; do not mix installations on one Endpoint.
- Follow the safe removal/update/rollback procedure below. Exiting Pi does not stop background transport.

<a id="依赖与-host-提供的运行时包"></a>

### Dependencies and Host-provided runtime packages

The package declares `peerDependencies: { "@earendil-works/pi-coding-agent": "1.3.0" }`. For tarball prefix installation, npm installs that exact version in the consumer tree. Native managed npm uses `--legacy-peer-deps` to suppress automatic peers, and the independent 1.3.0 Host tree supplies them. This satisfies `pi-tui-kit`'s `"*"` peer without pulling a different full Pi generation such as 1.4.x. `@earendil-works/pi-tui` and `@sinclair/typebox` remain **pinned dependencies**, not peers: compiled ESM (TUI key handling and TypeBox runtime validation) must physically resolve from the installation tree in local-package mode. Changing them blindly to `"*"` peers could pull latest versions incompatible with the 1.3.0 Host. Pi warns that Host-provided packages should be peerDependencies. This known distribution tradeoff means two copies of same-version runtime code; recorded loading/first-run checks passed. Redesigning Host mapping is outside this guide.

<a id="5-安全卸载升级与回滚"></a>

## 5. Safe uninstall, upgrade and rollback

These are manual prerequisites, not a new uninstall CLI or authorization to scan every Session on the machine. Use `pi list` to record exact source, personal/project scope, actual package root, approved Node/Pi/npm, profile, Store/Exchange and relevant Sessions/processes. Historical PIDs/filenames do not authorize signals.

1. In the Manager that can prove ownership of the target instance, explicitly `/ce-tunnel stop`, then independently `/ce-tunnel status`. Verify completed exit and **STOPPED**. `/ce-tunnel doctor` is qualification only, not exit evidence. External Owner, UNKNOWN, STOP_UNCONFIRMED or unknown lease/lock means stop the procedure: no deletion, bulk kill or unknown-outcome retry. Verify STOPPED even if transport was never started; do not start it to uninstall.
2. For every affected local binding you own, run `/ce-tunnel deactivate` and verify normal release/detach with `/ce-status`. Revoke/Recovery cannot substitute for normal release. Stop on unconfirmed release, failed evidence writes or UNKNOWN.
3. Confirm with other users that the package/Node prefix, profile, Store, background instances and shared resources are no longer needed. If another independent Session/installation still depends on them, STOP before native remove: do not uninstall, unregister or delete directories. Existing commands **cannot automatically prove** nonuse by all machine/other-user sessions. If uncertain, STOP and retain evidence; do not stop their Sessions.
4. Normally exit all relevant Pi Hosts you own, including Hosts able to load old code, and confirm exit. Exit does not replace transport Stop. Leave unrelated Sessions alone.
5. Remove using the recorded native Pi source and same scope:

```sh
# 仅适用于原生 managed npm 安装（0.2.0 的安装证据来自私有 loopback registry）
"$CE_APPROVED_NODE" "$CE_PI_CLI" remove "npm:@zieglar/pi-chat-exchange@0.2.0"
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
# 若原来是 --local 安装，remove 同样加 --local，勿扩大到其他作用域。
# tarball/源码目录路线：remove 后面的参数必须改为 pi list 中原始绝对目录 source。
```

Pi 1.3.0 `removeAndPersist` performs native remove before removing the declaration. For npm sources, `uninstallNpm` calls npm uninstall, which **deletes** managed package files. Do not additionally rm/npm uninstall the Pi managed root; it may contain other extensions. A local-directory source is only unregistered; its directory is retained. Partial remove or unconfirmed persistence also means STOP and retain evidence, without blind retry/manual directory deletion.

6. Only a dedicated **tarball consumer or dedicated host prefix** that you own, exclusively control and have proved has no other dependencies may be manually deleted separately. Do not delete shared Node, the Pi managed root, other installations or source trees. Keep anything of uncertain ownership/dependency. Retain Store (including WAL/SHM/host-secret), profile, credentials, bindings, history and state/log evidence by default. Do not purge, delete locks, clear Owners or resend unacknowledged messages.

Upgrade: retain the original exact artifact/version, SHA256, source, lockfile and configuration locations. Follow Stop/release/exit above, then native Pi remove of the old exact source and install of the new exact version. For tarballs, physically install to a new dedicated consumer prefix before registration rather than overwrite a directory in use. After Host restart, doctor/status, verify selected configuration and Store, then explicitly activate. No automatic Start.

Rollback/reinstall: first confirm target Store/schema/runtime compatibility. If unknown, STOP without downgrading, overwriting or deleting Store. With compatibility and authorization established, use the same Stop/release/exit procedure, remove current version, reinstall the retained exact artifact/version and verify actual load path/configuration. Reinstall 0.2.0 with the same exact npm source. Retained configuration does not renew authorization; explicitly activate. Missing ACK, timeout and DELIVERY_UNKNOWN do not permit retry.
