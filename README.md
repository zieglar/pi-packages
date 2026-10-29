# Pi Packages

English | [简体中文](README.zh-CN.md)

Packages that extend or integrate with Pi. Start with [Pi Chat Exchange](packages/pi-chat-exchange/README.md) for durable, explicitly authorized message exchange between ChatGPT and Pi.

## Pi Chat Exchange

- [Installation, configuration and quick start](packages/pi-chat-exchange/docs/getting-started.md)
- [Architecture and lifecycle](packages/pi-chat-exchange/docs/architecture.md)
- [SQLite Native driver](packages/pi-chat-exchange/docs/native-sqlite.md)
- [Security, troubleshooting, development and releases](packages/pi-chat-exchange/docs/operations.md)
- [Bilingual documentation](packages/pi-chat-exchange/docs/documentation.md)

Wayforge owns governed tasks, policy, recovery and completion authority. Chat Exchange owns message delivery/lifecycle, evidence and reconciliation. Pi provides sessions, runtime and provider transport. A message receipt does not grant task completion authority.

## Development

Use the package's runtime requirements. CE's current source declares Node `>=24.20.0 <=24.22.1`, Pi `1.3.0` and pnpm `12.9.1`; runtime admission applies additional checks. From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
```

Optional client/host tests and release qualification have their own prerequisites. Local tests do not establish cloud connectivity or publication. See the [development guide](packages/pi-chat-exchange/docs/operations.md).

## License

Pi Chat Exchange is [MIT](packages/pi-chat-exchange/LICENSE), Copyright (c) 2026 zieglar. Dependencies retain their own licenses.
