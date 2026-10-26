# Changelog

## 0.2.0 — UNRELEASED / DRAFT

First packaged candidate. Version 0.1.1 was an internal private version only; it
was never published to npm, so nothing below is an upgrade from a public release.
The package stays `private: true` and no publication is authorized.

### Messaging

- Add the default-disabled, opt-in `ce_ack` MCP tool, advertised only when the
  binding declares the Session-authorized ACK capability. The host supplies all
  authority fields and equivalent calls replay the original receipt. An ACK
  records a recipient reception statement — not proof of delivery, reading,
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

- This candidate's certification target is exactly **Node 24.21.0 + Pi 1.3.0 +
  macOS arm64**.
- Node **24.22.1** was admitted earlier as a second permitted runtime and remains
  declared in `engines`. That historical admission is **not** part of this
  candidate's certification. Linux is experimental and unverified.

### Packaging and documentation

- Prepare the prebuilt Pi extension npm candidate and consumer documentation
  closure. Candidate `version`, `repository` and public `publishConfig` are
  INACTIVE metadata; `private: true` keeps npm's own publication refusal in force
  while license and rights-owner authority are absent.
- Document owned transport Stop, independently confirmed STOPPED, normal binding
  release and then native Pi removal; Store, profile, credentials and history are
  retained.
- Keep managed npm, physical tarball fallback and monorepo source development
  routes distinct.
- Cloud transport is NOT_VERIFIED; offline synthetic fixtures only.

### Release-process note

The queued `.changeset/ce-e2b-ack-mcp.md` patch entry describes the same `ce_ack`
behavior change, and its content is already reflected in this DRAFT. It is
deliberately **not** consumed here: Changesets remains the repository's version
authority, and a future Changesets version PR must reconcile and consume it —
together with this hand-written 0.2.0 entry and the candidate version pins —
before any public release. Root Changesets configuration and queued entries are
untouched by this delta, and `privatePackages.version: false` keeps the queued
entry inert for this private package.

**Publication blocker: LICENSE PENDING.** Await existing license and
rights-owner authority from the user. No license choice or publication is
authorized by these materials.
