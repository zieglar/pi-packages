# License and dependency notices

English | [简体中文](licenses.zh-CN.md)

Pi Chat Exchange's own code is licensed under [MIT](../LICENSE), Copyright (c) 2026 zieglar. Dependencies keep their respective licenses; CE's license does not relicense third-party code.

## Dependency scope

The current package declares runtime dependencies `@earendil-works/pi-tui@1.3.0`, `@modelcontextprotocol/sdk@1.30.1`, `@narumitw/pi-tui-kit@0.66.0` and `@sinclair/typebox@0.34.52`, with peer `@earendil-works/pi-coding-agent@1.3.0`. Refer to the installed dependency manifests and license texts for their terms. The recorded dependency review identifies these packages as MIT. Some upstream Pi 1.3.0 tarballs omit a standalone LICENSE file; their package metadata and corresponding upstream tag license were checked during the license review. This does not make CE the licensor of those packages.

Native source uses its pinned Rust dependency graph; consult `Cargo.toml`, `Cargo.lock` and dependency licenses. Native binaries and the npm package are separate artifacts; npm0.2.1 contains no Rust Native binary. Tunnel client is separately installed with its own license/provenance requirements.

## Distribution and contributions

Preserve copyright and permission notices when redistributing covered code. Check exact dependency versions and their license payload before a new release; a prior review is not evidence for an upgraded dependency. Do not add unreviewed assets or assume that publishing CE grants rights over a separate client, service or plugin.

The current public npm package is `@zieglar/pi-chat-exchange@0.2.1`. Publication changes neither license terms nor warranty. Documentation edits do not change already-published package bytes. See [operations](operations.md) for validation boundaries.
