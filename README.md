# pi-packages

Pi 插件公开分发仓库（Public distribution snapshots of audited Pi plugins）。

本仓库是经过审计的**发布快照**：每个包在进入这里之前，都在独立私有开发仓库中完成实现、评审与发布门禁。本仓库不承载日常开发，不含内部流程与证据材料。

## 包

| 包 | 版本 | 说明 |
|---|---|---|
| [`@zieglar/pi-chat-exchange`](./packages/pi-chat-exchange) | 0.2.0 | Pi Chat Exchange —— 面向 Pi Host 与 ChatGPT 的 Session 授权双向消息交换（见包内 README 与 `docs/`） |

## 开发

```bash
pnpm install          # 安装工作区依赖（Node >= 22，pnpm 12.9.1）
pnpm build            # 构建全部包
pnpm typecheck        # 类型检查
pnpm check            # 包架构契约检查
pnpm test             # 默认测试道（真实客户端/真实 Host 等需真实环境的 lane 不在其中，见各包 package.json）
```

## 许可证

各包许可证见包内 `LICENSE`（`@zieglar/pi-chat-exchange` 为 MIT，Copyright (c) 2026 zieglar）。第三方依赖保留各自许可。
