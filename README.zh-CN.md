# Pi Packages

[English](README.md) | 简体中文

这里提供扩展或集成 Pi 的包。[Pi Chat Exchange](packages/pi-chat-exchange/README.zh-CN.md) 用于 ChatGPT 与 Pi 之间经显式授权的持久化消息交换。

## Pi Chat Exchange

- [安装、配置与快速开始](packages/pi-chat-exchange/docs/getting-started.zh-CN.md)
- [架构与生命周期](packages/pi-chat-exchange/docs/architecture.zh-CN.md)
- [SQLite Native 驱动](packages/pi-chat-exchange/docs/native-sqlite.zh-CN.md)
- [安全、故障排查、开发与发布](packages/pi-chat-exchange/docs/operations.zh-CN.md)
- [双语文档维护](packages/pi-chat-exchange/docs/documentation.zh-CN.md)

CE 不判定任务是否完成：任务治理、策略、恢复和完成裁决属于使用 CE 的外部工作流或操作员。Chat Exchange 负责消息投递/生命周期、证据和对账；Pi 提供 Session、运行时和 Provider Transport。消息回执不授予任务完成权威。

## 开发

按包要求选择运行时。CE 当前源码声明 Node `>=24.20.0 <=24.22.2`、Pi `1.3.0` 和 pnpm `12.9.1`，实际准入还有额外检查。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
```

可选 client/Host 测试和发布资格验证各有前提，本地测试不证明云连接或发布成功。参见[开发指南](packages/pi-chat-exchange/docs/operations.zh-CN.md)。

## License

Pi Chat Exchange 使用 [MIT](packages/pi-chat-exchange/LICENSE)，Copyright (c) 2026 zieglar。依赖保留各自许可证。
