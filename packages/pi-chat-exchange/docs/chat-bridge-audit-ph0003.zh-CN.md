[English](chat-bridge-audit-ph0003.md) | [简体中文](chat-bridge-audit-ph0003.zh-CN.md)

> 历史源码审计。以下结论针对固定来源及当时阶段，不代表当前支持或发布资格。

# PH-0003：Chat bridge 源码审计与 endpoint 比较

只读审计；下载源码未安装或执行。没有将外部代码提取到本项目或引入为依赖。结论描述固定实现，不是实际 Desktop 集成验收（NOT_RUN）。所有者在合同修改前批准模型 C：ControlSurface + capability-oriented Endpoint integration。

## 可复现 pin 和许可证证据

完整 LICENSE 均已阅读，不是从 README 推断。

| 仓库 | 审计提交 | 许可证 | 源码归档 SHA-256 |
| --- | --- | --- | --- |
| [kajmahal/chatgpt-conversations-mcp](https://github.com/kajmahal/chatgpt-conversations-mcp) | `4c2640d88cc95df1fa3d4d1c60f433d452c97351` | Apache-2.0 | `6b03fe4ff77c4ce41f88dd30fa70d2e682a70bde82d9d700561d8188d958b810` |
| [hxmzadmr/probridge](https://github.com/hxmzadmr/probridge) | `e9ed93fb92f39a04eb106488be7733b396eecff0` | MIT, Hamza Demir | `d778ac74ca09585b521b55c2dbfcc3aed41d92f14fe06384c398c6ebedaea570` |
| [connectedGraph/chatgpt-desktop-bridge](https://github.com/connectedGraph/chatgpt-desktop-bridge) | `4d159df296ac3443972782611505806407ebefd5` | MIT, Springingly | `67ce45dae99edd0e5be319e447d792b2ac2e25256e885703afbb46f868626ca9` |
| [ysbiyiklioglu/ChatGPT-Bridge](https://github.com/ysbiyiklioglu/ChatGPT-Bridge) | `3c9e5d6a8000f86b218d8eb1b585a2e9f22acaf1` | MIT | `1f743d0dcc41952ea81b86162fefc4ad784b96387d97b318663a820e07e09932` |

按精确提交获取仓库归档；下列源码定位指向该树。重建审计不需要 `/tmp/ph0003-source-audit` 下的临时 checkout 路径。每个 bridge 结论均为 REFERENCE_ONLY；其私有/UI transport 不作为本项目实现依赖。

## A. chatgpt-conversations-mcp

来源：`src/{mcp-server,message-service,bridge,native-call,pipe-client,desktop-locator,refreshing-bridge}.mjs`。

1. 已有 conversation identity 为原生 `thread.id`，对外暴露为 `conversation_id`。
2. 经 `list_threads` 列出 thread，过滤 `kind=chatgpt`、pinned/recent。
3. 通过分页 `read_thread(threadId,cursor)` 读取已有 thread；重复 cursor 被拒绝。
4. 经 `send_message_to_thread(threadId,prompt)` 发往已有目标；写入单独启用，预读会拒绝活跃 thread。
5. 原生 JSON-RPC UUID/callId 关联 RPC。响应选择查找 baseline ID 中没有的新 turn，并精确匹配发出的用户文本；assistant 文本属于该 turn。这是启发式，不是持久消息去重。
6. Conversation ID 独立于 request、target turn 和 carrier ID。
7. MCP stdio -> service -> Windows `codex-browser-use-*` named pipe，四字节 little-endian 长度前缀 JSON。
8. 原生 `tools/call`、namespace `codex_app`、carrier threadId/turnId/callId 依赖私有/内部 Desktop 机制，不是 PH-0001 确立的受支持 custom-plugin 路径。
9. 可参考独立 address/read/write seam、endpoint 与 turn/RPC identity、发送一次再观察、歧义后不重试写入。不能依赖私有 pipe/tool、carrier 创建，以及缺少 receiver fencing/durable dedupe 的路径。
10. Apache-2.0；不建议代码复用。

只有内存中的 per-conversation lock；没有持久 dispatch/result/inbox。读 rediscovery 重试一次；写失败使 cache 失效但绝不重发。默认 native timeout 12 秒、reply polling 90 秒。`completed` 从 assistant 文本推断，不是权威 turn settlement。`sent_reply_pending` 与 `delivery_uncertain` 的区分有用，但不是执行证明。源码证明了可寻址 conversation 概念，不是官方支持的生产集成。

## B. ProBridge

来源：`src/server.mjs`（startJob/statusJob/followupJob）、`src/daemon.mjs`（handle/recoverOnStartup/watchJob）、`src/lib/{queue,dispatch,ui-worker,ax-driver,fs-atomic,control-sync,job-file}.mjs`、`src/native/ax-driver.swift`。

1. `jobId` 表示一轮处理，不是原生 conversation identity。初始 `threadId` 等于首个 jobId；follow-up 保留该逻辑聚合。
2. `start` 经 daemon 入队，在 admission 后立即返回 jobId/status/position，不等待模型完成。`status` 是独立 MCP call。
3. follow-up 要求最新一轮完成、无其他活跃轮次且 title 已验证；创建新 jobId/nonce，保留 threadId，增加 next round 和 parentJobId。
4. MCP 进程继续服务调用，但初始 tools/call 不等待外部模型完成。
5. 状态包括 queued/submitting/submitted/running/settling/complete/failed、dispatch_unknown/protocol_missing/timed_out/cancelled。协作文件报告关联 jobId/nonce/workspace/round/parent/thread；UI 也用于判断 settlement。status read 可以应用观察并修改状态，不能采用该行为实现本项目不修改状态的 Result read。
6. 私有 runtime 目录使用 JSON queue + backup、mutex 和 atomic rename。可跨重启持久化；源码未确立 fsync durability 或 exactly-once delivery。nonce/marker 不是 endpoint authentication。
7. startup 恢复 watcher/reconcile submitting。持久化的 send-phase 歧义变为 dispatch_unknown，不重发；发送前恢复可能安全失败。
8. MCP stdio -> 本地 Unix socket -> detached daemon -> Swift Accessibility/CGEvent Quick Chat UI driver，目标 `com.openai.codex`；使用捕获的 title 和 marker，不是 CDP 或官方 conversation-addressing API。
9. 可复用思路：aggregate/thread 与 per-round job、dispatch identity 分离，submit/admit/poll，effects 前记录 intent，重启隔离。UI title、可变协作报告、产品 effort/model 字段不适合作为通用证明。
10. MIT。不建议执行/安装/提取 daemon。

持久不透明 job identity 是处理/关联 handle，不证明原生 conversation 可寻址性。一个逻辑聚合含连续轮次，概念上对应 Exchange + 独立 Message/Attempt，而非永不结束的单一 job。

## C. ChatGPT Desktop Bridge

来源：`bridge.py`，尤其 `CDPBridgeClient.call`、`get_dom_conversation_id`、`send_chat_message` 和 HTTP handler。

1. 只寻址当前 DOM conversation。传入不同 ID 会新建 chat，不会选择已有 conversation。
2. ID 来自 DOM `data-response-annotation-conversation` 或 `data-content-search-{unit,turn}-key` 前缀；`current_conv_id` 仅在内存。看似 backend ID 不能证明此 bridge 有稳定 resume 语义。
3. 省略/新 ID 创建 chat；匹配当前 ID 则继续；不匹配则另建。未发现任意 ID list/read 支持。
4. HTTP request 在 asyncio lock 下串行。CDP 数字 ID 关联 RPC；assistant count/latest DOM text 定位响应。Stop 按钮消失和文本稳定用于猜测完成；HTTP completion UUID 不是 dispatch identity。
5. CDP call 对任何 method 都 reconnect/retry 两次，包括 effects。75 秒 polling timeout 可返回部分/最后文本；HTTP 80 秒 timeout 返回 500，但不取消 future。均不能证明无效果或 runtime settlement。
6. debug-port discovery + CDP WebSocket `Runtime.evaluate`/Input event + ProseMirror/DOM selector；以 remote debugging 启动 Desktop。
7. transport 被拒绝：私有 selector 和重复效果重试。
8. 可参考 conversation identity 与 RPC/completion identity、HTTP control 与 CDP integration 的区别。不能只因 API 接受 conversation_id 参数就宣称任意寻址。
9. MIT。没有持久 queue/dedupe/evidence/recovery registry。

## D. ChatGPT-Bridge

检查了 `server/src/{mcp-server,ws-server,index}.ts` 和 `server.cjs`，以及扩展 background/content 源码。目录不同：TS 使用带连字符的 send/status/new-chat/history/debug；CJS 使用下划线变体，并增加 quick/upload/images/download。

MCP stdio -> 本地 WebSocket（可选 HTTP frontend）-> MV3 extension background -> content-script DOM 操作/抓取。可选 native messaging helper 不构成稳定 conversation 寻址。选择首个匹配 ChatGPT tab，没有 conversation-ID routing/listing。history 是当前可见 DOM 和内存 server history；检查源码声明 `_maxHistory=20`，但未强制执行。

server UUID requestId 把 WS result/error 映射到 pending request。content script POLL_RESULT 使用一个全局 pending/result/error slot，没有 requestId，并发请求可能混用观察。`started` ACK 早于实际 send/acceptance 证明。timeout/disconnect 拒绝 pending promise；reconnect 仅恢复 socket，不恢复持久 execution correlation。chrome.storage 持久化连接元数据，不保存 inbox/result。Stop/text-stability timeout 可能返回最后文本，不代表 settlement。

文件上传通过 base64/Blob/paste；ACK 可能仅表示尝试 paste，不代表处理完成。这不足以支持 PH-0003 通用文件协议。MIT。经验：control/integration 分离，tab/conversation/request/execution ID 独立，每个边界都需关联，明确 acknowledgement 强度。

## 重要补充证据；不是生态目录

公开 GitHub 搜索覆盖现有 Claude conversation MCP、Codex session MCP、异步 job/task bridge、desktop conversation bridge 和 Pi MCP；也初筛了 npm 元数据。搜索元数据不作为源码证明。web-search provider 部分失败；直接 GitHub/npm HTTPS 搜索成功。只有两项官方参考实质细化了决策，没有新增依赖。

- [openai/codex](https://github.com/openai/codex)，提交 `7aa8f510496316b86a91a75ed0a71598ef03c640`，已完整阅读 Apache-2.0 LICENSE。实际生成协议位于 `codex-rs/app-server-protocol/schema/typescript/v2/`：ThreadResumeParams 按 ID 重新加入运行中 thread 或从磁盘加载；ThreadListParams 枚举 thread；TurnStartParams 定位 threadId；TurnCompletedNotification 绑定 threadId + Turn；TurnInterruptParams 绑定 threadId + turnId；TurnStatus 区分 inProgress/completed/failed/interrupted。REFERENCE_ONLY：实质印证 endpoint identity 与 per-turn correlation、条件观察/取消的区别，不是 runtime integration。
- [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)，提交 `8e12bf3c8f01f374146acfa19b8ece0018bfc86c`，实际 `schema/2025-11-25/schema.ts:1302–1500` 和 ToolExecution.taskSupport。Task creation/status/result/cancel/list 携带 taskId/status/ttl/pollInterval；notification 可选，task support 分 forbidden/optional/required。RPC task identity 不是 conversation identity 或外部执行证明。双向 sampling/elicitation 同样不是向指定 conversation 注入。根 LICENSE 记录 Apache-2.0/MIT 过渡，非规范文档为 CC-BY-4.0；不建议提取/复用。REFERENCE_ONLY。

## 跨 endpoint 能力比较

ChatGPT 列是已审计中最强的 native-pipe 示例，不是受支持 API 或本项目已实现 adapter。其他实现更弱（AX title、当前 DOM、首个 tab）。Pi 列原样采用 PH-0002 证据：`source-reuse-audit.md`。

| 能力 | ChatGPT 风格 endpoint 证据 | Pi endpoint 证据 |
| --- | --- | --- |
| stable address | native thread ID；私有，无支持稳定性承诺 | 持久 session binding 可行；install/session mapping 留在本地 |
| receive message | native send 到已有 thread | 公开 owning-session sendUserMessage/sendMessage |
| produce result | text/turn 启发式；不证明 settlement | 可观察 output；仍需关联 publication |
| follow-up | 同一 thread，独立 turn/request | 同一 session，独立 incoming Message |
| correlation | RPC + turn ID、精确文本启发式 | 必须集成 Message/Attempt 和 runtime observation |
| runtime instance | 未规范化/持久化 | 新 process/registration epoch 可行 |
| delivery ACK | private RPC response，跟踪歧义 | receipt tier/API return，本身不证明执行 |
| execution observation | bridge 中较弱的 text/status 启发式 | lifecycle event 可用；不是自动 per-message correlation |
| cancellation | 这些 bridge 未支持/未证明 | 审计 seam 未确立 cancellation confirmation |
| durable receiver dedupe | 无 | 公开 API 无；必须在 effects 前构建 |

这些是能力/证据差异，不是固有 client/agent 角色。现有 Pi 插件仍 REFERENCE_ONLY：intercom roster/epoch/receipt ladder、remote-pi socket transport/registration、relay mailbox core 和官方 handoff context summary 可供参考；不采用它们现有 injection/retry 机制。可选 discovery composition 与最小 owning-session endpoint integration 决策保持分开。

## 架构结论

MCP 是 control/API surface，不会自动成为调用方 conversation 的 endpoint integration。caller principal 和可寻址 target 是不同身份。集成提供真实能力时，conversation 和 runtime 可作为协议 peer，无需强求能力对等。grant scope 按需绑定认证 principal + action + Exchange/Message/Attempt/recipient incarnation/owner。缺失支持保持 unknown/unsupported，不合成证据。read 不修改状态；Result 是处理证据，reply 是单独路由的 Message。获准的 unresolved disposition 属于管理记录，不是执行证明。
