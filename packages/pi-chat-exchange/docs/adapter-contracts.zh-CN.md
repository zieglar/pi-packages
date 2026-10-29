[English](adapter-contracts.md) | [简体中文](adapter-contracts.zh-CN.md)

# 控制表面与端点契约：PH-0003

> 历史阶段记录：下文的“当前”“未来”和实现状态指 PH-0003。当前 MCP 工具绑定见 [delivery-ack-contract.md](delivery-ack-contract.zh-CN.md)；此处不据历史声明承诺当前支持范围。

本阶段用相互独立的平面替换带方向含义的 ClientAdapter/AgentAdapter 命名。它不实现投递、认证、持久化或完整控制 API。

## MCP 控制（`src/control/mcp/`）

- 当时的实现：保持只读 `ping` 不变，使用 stdio 和 TypeBox 校验；格式错误的输入返回 invalid-params；stdout 只输出协议帧，不访问环境。
- 未来：将 request/read/cancel 操作转换为经过认证的 core 调用。`CONTROL_OPERATIONS` 保留 exchange_send/get/list/cancel/result 名称；Owner close/archive 是独立的可选能力，不是已绑定工具。
- tools/call 请求 ID 只用于 API 关联，不是发起调用的对话的持久端点身份。MCP tasks 同样表示 RPC 工作，不代表具名对话。sampling/elicitation 不能建立向对话注入消息的能力。
- 未来的 send 调用需要显式授权的源 EndpointRef 绑定；绝不能根据 MCP 请求 ID 编造原生对话身份。仅作为来源的 Participant 可以声明投递 unsupported/unknown。这允许发起请求和读取控制结果，不代表能将回复注入调用方对话。本阶段未实现此类绑定。
- frontend 获取经过认证的 host 授权，不能创建投递或 runtime 证明。host 范围的 grant 不被接受为调用方凭证。
- CLI、HTTP 和原生控制表面是未来的替代方案，本阶段不存在。
- PH-0001 插件/隧道证据保留为档案；未发生安装/隧道变更，也未发生真实客户端调用（NOT_RUN）。

## 端点集成（`protocol/endpoint-capabilities.ts`）

不采用巨型接口或继承层级。最小声明为 `EndpointDeclaration { kind, capabilities }`。必须显式声明投递支持；观察、取消、后续消息和 Result 生成支持彼此独立，均为可选项。每项取 supported/unsupported/unknown；缺失表示 unknown。能力声明不是 Receipt、runtime 事件、已完成的 Result 或 grant。

未来的绑定解析不透明端点身份，提供关联的投递观察和其确实支持的 runtime 观察。也可以向同一 principal 授予请求权限，使其发起另一条 Message；经 host 发起请求不要求先实现 MCP 控制。对话双方不必支持相同的观察/取消方法。缺少证明会阻止对应转换；不能把超时、DOM 文本或 ACK 提升为 settlement。已确认传输但 runtime 未知时，不能将其重新归类为投递不确定。未来的准入策略可以在副作用发生前拒绝不受支持的工作流；本阶段未实现此类策略或 adapter 方法。

## Pi 端点（`src/endpoints/pi/contract.ts`，仅声明）

- 所属 session 的公开 API 仍为 sendUserMessage/sendMessage、sessionManager、生命周期事件和 appendEntry（已审计官方 0.86.1 文档）。
- 官方 handoff 将上下文汇总到一个新 session/editor；它不能用作已有 session 的传输。不创建竞争的 RPC session。
- 持久端点在本地映射到 installation/host + 持久 session 绑定；重启会改变 live instance/registration epoch。单独的 PID、cwd、pane ID 或 runtime alias 不具有持久性。未冻结端点字符串语法。
- 凭证、provider/session 文件句柄、SSH key 和 Herdr 元数据仍留在 adapter 本地。EndpointRef 仍恰好只有 adapter/endpointId/instanceId?。
- 持久去重、fencing、副作用前的 dispatch intent 和不确定时禁止重试的规则，必须在任何外部副作用前执行。公开 API 可用本身不构成逐 Message 的 acceptance/settlement 证明。取消确认仍未获证明。
- 本阶段 Pi 没有已实现的支持声明或投递代码。现有插件保持 REFERENCE_ONLY；以后可以考虑仅用于发现的组合方式。PH-0002 的固定版本及源码发现仍记录在 source-reuse-audit.md。

## 未来的对话端点

不存在 ChatGPT 实现或占位目录。四个经过审计的 bridge 仍为 REFERENCE_ONLY（chat-bridge-audit-ph0003.md）。私有 Desktop API、CDP、DOM 自动化、无障碍驱动和浏览器扩展均不是依赖。禁止 control/endpoint 之间和端点之间相互导入；通用 contracts/core 向内共享。未来的 ChatGPT 端点不得要求 MCP SDK 或其 frontend。

## 权限与证据

未来经过认证的 host 提供封闭的 principal/action/scope context，替代 client/agent 标签。Owner close/archive、request、delivery、runtime progress、settlement、publication 和 cancellation confirmation 都需要独立 grant。grant 匹配是纯校验，不是认证、证据来源验证或持久 CAS。host 认证 issuer/principal/endpoint/consumer/owner 映射，并在事务内加载所有权威记录。确切 scope 见 architecture.md。
