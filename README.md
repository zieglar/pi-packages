# Pi Packages

A pnpm workspace for independently owned packages that extend or integrate with Pi.

## Packages

- [`wayforge`](packages/wayforge/README.md) — deterministic agent orchestration kernel. This is the only initial package.
- [`pi-chat-exchange`](packages/pi-chat-exchange/README.md) — generic chat-exchange protocol: Exchange aggregate, independent message/result lifecycles, pure core rules, and an MCP ping smoke (durable host deferred).

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
