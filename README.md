# Pi Packages

A pnpm workspace for independently owned packages that extend or integrate with Pi.

## Packages

- [`wayforge`](packages/wayforge/README.md) — deterministic agent orchestration kernel. This is the only initial package.
- [`pi-handoff`](packages/pi-handoff/README.md) — durable handoff protocol between ChatGPT and the local Pi runtime (Phase 0/1: frozen contracts + MCP ping smoke).

## Development

Requires Node.js 22 or newer and the package manager pinned by `packageManager`.

```bash
pnpm install --frozen-lockfile
pnpm check:workspace
pnpm build
pnpm typecheck
pnpm test
pnpm check
```

See the [workspace contract](docs/workspace-contract.md), [contribution guide](docs/contributing.md), and [licensing policy](docs/licensing.md).
