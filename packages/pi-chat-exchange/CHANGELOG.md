[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

## 0.2.2

### Patch Changes

- Accept group-writable ancestor directories for an explicitly selected Tunnel Client while retaining strict automatic discovery. Validate literal Homebrew wrapper targets and exclude shell expansion from exec identity evidence. Native, Node, credential handoff and owned Stop behavior are unchanged.

- Managed profiles explicitly set `MCP_STDIO_FAILURE_POLICY=exit`, overriding an inherited restart policy. With 0.0.19, an MCP child failure exits the client instead of restarting the child. CE does not respawn it, take over ownership or retry messages; inspect ownership and use explicit operator recovery before restarting. Compatibility is limited to the exact matrix entries, including historical older-client scope.

- Explicit selection delegates trust to the external program and its installation writers. File group-write, world-write, owner, macOS ACL and project-path checks remain. Other effective writers may replace a selected program and expose Tunnel credentials; check-to-execution races remain.
- This is a local RC using a physical tarball; npm 0.2.1 remains published. The [compatibility matrix](compatibility/README.md) records source-matched 0.0.19 macOS arm64 legacy-identity manual bidirectional Cloud E2E and Linux x64 synthetic lifecycle checks. Historical 0.0.16 evidence is limited to its recorded RC runtime; 0.0.18 and real namespaced Cloud remain NOT_VERIFIED. Latest monitoring and actual same-run publication integration remain NOT_VERIFIED. No Homebrew permission or Gatekeeper workaround is required.

## 0.2.1

Version 0.2.1 includes:

- Rust Native SQLite as the only default persistence driver, using the existing `ce-sqlite-v0.1.0` pins. No automatic download or fallback to `node:sqlite`.
- Native readiness checks that keep Pi management available while refusing Store, messaging and Tunnel start when Native is not ready. Explicit `/ce-native` status, verify, install, repair and update-discovery commands; restart Pi after installation before setup or messaging.
- Node `>=22.19.0`, matching Pi 1.3.0's Host minimum. Local Node 22 / Pi 1.3.0 first-run and persistence checks passed; Linux x64 hosted checks passed 227/227 on Node 22.19.0 and 24.22.2. Linux arm64 Store qualification, WSL2 integration and cloud transport remain unverified.
- A minimal npm distribution with prebuilt runtime files and GitHub-linked operating guides, plus release CI and installed-Host fixture fixes.

### Release-process note

The ACK changeset has been consumed and reconciled with the behavior already described under 0.2.0. This is versioning bookkeeping, not a new ACK feature in 0.2.1. The historical 0.2.0 entry below is preserved.

## 0.2.0

Published on npm as `@zieglar/pi-chat-exchange@0.2.0`. The qualification and feature claims below describe this release, not later development support.

First packaged release line of this extension. Version 0.1.1 was an internal
private version only; it was never published to npm, so nothing below is an
upgrade from a public release.
CE's own code is owner-authorized MIT, Copyright (c) 2026 zieglar.
Third-party license evidence is complete and `private: true` is removed from the manifest.

### Messaging

- Add the default-disabled, opt-in `ce_ack` MCP tool, advertised only when the
  binding declares the Session-authorized ACK capability. The host supplies all
  authority fields and equivalent calls replay the original receipt. An ACK
  records a recipient reception statement: not proof of delivery, reading,
  processing or task completion. BUSY rollback and uncertain outcomes never grant
  retry permission.

### Tunnel lifecycle commands

- Add `/ce-tunnel doctor`: read-only qualification diagnostics. With no trusted
  client installed it reports a safe refusal such as `CE_EXECUTABLE_UNTRUSTED`.
  That refusal is the expected diagnosis, not an install failure, and `doctor` is
  never an exit proof.
- Add `/ce-tunnel deactivate`: bounded, normal release of this Session's own
  binding, retaining registration and history. It is not revoke and not Recovery.

### Multi-session and runtime

- Support independent Pi Sessions on a shared Tunnel: `/ce-tunnel convert` keeps
  the current native Session's original endpoint and `/ce-tunnel register` gives a
  new Session its own stable endpoint without starting transport.
- Support trusted portable runtime installations for the pinned Node launch path.

### Runtime qualification

- The 0.2.0 certification target is exactly **Node 24.21.0 + Pi 1.3.0 +
  macOS arm64**.
- Node **24.22.1** was admitted earlier as a second permitted runtime and remains
  declared in `engines`. That historical admission is **not** part of 0.2.0's
  certification. Linux is experimental and unverified.

### Packaging and documentation

- Prepare the prebuilt Pi extension npm distribution and consumer documentation
  closure. The consumer tarball ships the operating guides plus the protocol,
  ownership, storage, ACK and Store-security contracts, so no repository access
  is required to operate the package safely. `private: true` was removed once the third-party audit closed with three-layer evidence. The
  owner-authorized MIT LICENSE ships in the prebuilt tarball; dependency licenses
  remain separate and must be preserved at installation/redistribution.
- Document owned transport Stop, independently confirmed STOPPED, normal binding
  release and then native Pi removal; Store, profile, credentials and history are
  retained.
- Keep managed npm, physical tarball fallback and monorepo source development
  routes distinct.
- Cloud transport is NOT_VERIFIED; offline synthetic fixtures only.

### Release-process note

The queued `.changeset/ce-e2b-ack-mcp.md` patch entry describes the same `ce_ack`
behavior change, and its content is already reflected in this 0.2.0 entry. It is
deliberately **not** consumed by this entry: Changesets remains the repository's
version authority, and a future Changesets version PR must reconcile and consume
it together with this hand-written 0.2.0 entry and the 0.2.0 version pins. Root
Changesets configuration and queued entries are untouched by this delta. With
`private` now removed, `privatePackages.version: false` no longer keeps the queued
changeset inert: the next Changesets version PR owns that reconciliation explicitly.

**Third-party evidence complete; `private: true` removed.** The 101-item dependency closure is fully audited: the two former evidence gaps (pi-tui and the Host peer) closed with three-layer exact-version evidence: registry tarball MIT declarations plus the upstream `v1.3.0` tag root LICENSE (MIT, (c) 2025 Mario Zechner); their artifacts omit license text (upstream packaging omission, not incompatibility). The per-version audit record is `docs/license-audit.md`, which is repo-only and not distributed in the tarball. Owner authorization covers CE's own code only: not a grant to relicense dependencies.
