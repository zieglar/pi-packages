# 许可证与依赖说明

[English](licenses.md) | 简体中文

Pi Chat Exchange 自有代码使用 [MIT](../LICENSE)，Copyright (c) 2026 zieglar。依赖保留各自许可证，CE 的许可证不重新授权第三方代码。

## 依赖范围

当前包声明运行时依赖 `@earendil-works/pi-tui@1.3.0`、`@modelcontextprotocol/sdk@1.30.1`、`@narumitw/pi-tui-kit@0.66.0`、`@sinclair/typebox@0.34.52`，以及 peer `@earendil-works/pi-coding-agent@1.3.0`。具体条款参见安装后的依赖 manifest 和许可证文本。既有依赖审查确认这些包为 MIT。部分上游 Pi 1.3.0 tarball 缺少独立 LICENSE 文件，许可证审查核对了其包元数据及对应上游 tag 的许可证；CE 不因此成为这些包的许可方。

Native 驱动源码有自己的固定 Rust 依赖图，参见其 `Cargo.toml`、`Cargo.lock` 和依赖许可证。独立发布的 Native 二进制与 npm 包是不同制品，npm 0.2.0 不含 Rust Native 二进制。Secure MCP Tunnel client 单独安装，需遵守自身许可并检查来源。

## 分发与贡献

重新分发受许可代码时保留版权和许可声明。新发布前核对精确依赖版本及其许可内容；先前审查不能证明升级后的依赖也已审查。不要加入未经审查的资产，也不要把发布 CE 理解为取得另一 client、服务或插件的权利。

公开 npm 包为 `@zieglar/pi-chat-exchange@0.2.0`。发布状态不会改变许可条款，也不意味着任何保证。本次文档编辑不创建新版本，不改变已经发布的字节。验证边界见[开发与发布运维](operations.zh-CN.md)。
