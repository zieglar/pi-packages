[English](daily-use.md) | [简体中文](daily-use.zh-CN.md)

# 恢复已配置的 CE 会话

本页面向 HANDOFF-CE-DAILY-INTEGRATION-01 的本地整合版 0.3.1-daily.1，保留已发布 CE 0.3.0 Hooks，并加入 Connect/Disconnect、持久启动许可和 TUI 改进。该本地构建制品与原 npm 0.3.0 发布不同；修改源码不会自动更新安装，须另行核对安装路径和制品身份。

## 首次设置

1. 按 [Tunnel 设置指南](tunnel-setup.zh-CN.md)选择已有合法 profile、Store、Exchange、Tunnel 与凭据引用。已有配置不必重建。首次选择非默认 profile 时，用 `CE_TUNNEL_PROFILE` 明确指定规范化绝对路径；确认授权后会记住所选 profile 与可信 client，供后续普通 `pi` 启动使用；不要同时加载两份 CE 扩展。
2. 使用批准 Node 启动 Pi，保持原有 Magpie 与扩展加载方式。用 Pi `/name` 命名这个会话，用 `/session` 核对它的身份。已有 `pi/main` 属于原注册会话；恢复那个会话即可，不要在新会话重新登记 `pi/main`。
3. 只有当前真实 Pi Session 尚未注册时才执行一次 [多会话注册](multi-session-usage.zh-CN.md)：明确 Stop 并核实 STOPPED，再 `/ce-tunnel register pi/你明确选择的独立名称`，核对 Store、Exchange、当前会话及权限后确认。需要正文或 ACK 才加 `--payload-read` 或 `--ack`。现有单会话配置可继续使用；只有需要多会话时才按指南显式 convert。不要重建 Exchange 来绕过注册问题。
4. 配置发布后 `/reload`，加载对应策略。缺少 mapping 的首次 reload 或已经正常结束的绑定可能显示 `CE_HOST_MAPPING_INVALID`；显式 connect 会请求合法激活，不丢弃旧历史，也不接管 Owner。
5. 在交互 TUI 执行 `/ce-tunnel connect`。没有有效许可时，先确认所选 profile、client、凭据引用访问、可能费用及后台生命周期，再进行激活或启动。取消或拒绝不会新增 grant、激活绑定或启动 client。`/ce-tunnel start` 需要许可时也会询问。确认后保存许可与所选 profile/client，后续普通 `pi` 启动无需 shell alias、shell 配置或 `CE_TUNNEL_BACKGROUND_ALLOW`。

保留原有批准运行时、模型与扩展配置。许可只允许显式启动，不自动启动，也不注册新的原生会话。范围与安全规则见[持久启动许可](tunnel-manager-background.zh-CN.md#persistent-startup-permission)。

## 每天使用

在原项目目录的外部终端运行普通 `pi`，在 Pi 选择器中选回**同一已注册会话**。然后：

```text
/ce-tunnel connect
/ce-tunnel status
```

connect 先检查交互 TUI、持久启动许可、Native/运行时与已加载配置的一致性。已有绑定有效时保持它；需要新 CE incarnation 时沿用原激活确认、STOPPED 配置锁和 `requireUnowned`。确认后才启动已有 profile 的 Tunnel，或对已运行实例进行健康实测，不创建第二套 Tunnel、Session 或消息机制。

状态分别显示 CE 绑定与实际 transport health。它不检测 Magpie 模型是否可用，不证明业务任务获准执行，也不证明消息送达、ACK 或任务完成。Manager 页面是读取时的快照，长时间打开后使用 Refresh 或 `/ce-tunnel status` 重新测量。

结束本次通信时：

```text
/ce-tunnel disconnect
```

确认框明确说明：释放当前 Pi 的本地 CE 绑定，并停止**所选 profile 的共享 Tunnel**，可能中断其他会话的传输；其他会话的 Owner、注册和历史不被删除。确认后先关闭当前 CE 准入，再分别等待正常 release 与 Manager Stop。任一阶段未知会报告 `disconnect incomplete`，保留失败证据；不会宣称成功或重新开放准入。停止过程中已准入的操作可能完成，无法撤回已提交的消息或外部效果。若 Manager 报告 MCP child 残留，不能把 tunnel 退出理解为所有组件都已清理。

随后正常退出 Pi。下次恢复同一会话再 connect，不必重新注册 Endpoint 或创建 Exchange。正常退出会结束 CE Owner；同一原生 Pi 会话的下次激活可以产生新的 CE incarnation，这不是把旧 CE Session ID 永久复用。

## 与原命令的区别

| 命令 | 范围 |
|---|---|
| `connect` | 复核当前会话既有注册与绑定，必要时确认激活，再显式启动或检查传输 |
| `disconnect` | 确认后正常释放当前绑定并停止共享传输 |
| `start` / `stop` | 保留原有传输生命周期语义；单独 stop 不释放本地 CE Owner，也不关闭所有本地工具 |
| `activate` / `deactivate` | 保留原有显式绑定/释放语义，不自动启停传输 |
| `status` / `/ce-status` | 前者测量 transport 与 Native；后者报告当前 CE 绑定与租约 |

不带参数执行 `/ce-tunnel` 可打开原有的状态感知 Manager。除配置与 start/stop 外，菜单提供 Connect、Disconnect、Status 和 Manage Permission。Permission 子菜单显示当前状态，并提供 View Status、适用的 Grant Permission / Revoke Permission 及 Back，复用原命令的确认流程；撤销不停止正在运行的 Tunnel。原有 permission 子命令保留。

交互模式的 `/ce-status` 与 `/ce-tunnel status` 在底部独立显示 `Esc  Close`，按键使用当前主题强调色。小终端优先显示关闭提示；Esc、配置的取消键与 Ctrl-C 均可关闭，状态准入和通知回退保持原有行为。

只想退出当前 Pi、让其他会话继续使用共享 Tunnel时，可正常退出或显式 deactivate；但下次需要新激活且共享 Tunnel 仍在运行时，当前架构要求操作者另行协调 Stop，再 connect。connect 不会替你中断共享实例。手动 Stop 可以打断进行中的 connect；没有自动重连或后台重试。

## 拒绝与剩余操作成本

- `CE_TUNNEL_BACKGROUND_UNAUTHORIZED`：先看 `/ce-tunnel permission status`。许可缺失、撤销或范围变化时，通过 connect 或 `/ce-tunnel permission grant` 明确确认。存储无效须人工检查，不删除或自动修复。重新输入密钥不能解决许可问题。
- 当前 Session 不在 allowlist：选回已注册会话；全新 Session 需要自己的明确注册。Endpoint 不猜测、不换绑，不把旧 Session ID 当成任意新会话的通行证。
- 未加载所选策略、profile/环境变化：显式 reload 后复核身份，不在旧 factory 中扩大权限。
- 需要激活但 Tunnel 运行或状态未知：查看 status，协调后显式 Stop 并核实 STOPPED，再 connect。
- Busy、过期 Owner、互斥或释放不确定：停止该恢复路径，按 [排障](tunnel-setup.zh-CN.md)核对精确证据；没有自动 takeover、Owner 删除或清理标记。
- 已绑定但启动失败：绑定保持已建立状态，传输失败单独报告。先检查 status，再作下一次明确操作；不自动解绑、重建 Tunnel 或重试。

持久授权取代此前的外部启动函数方案。仍需恢复同一已注册原生会话，必要时确认激活；记住 profile/client 路径不授权任意新会话使用 `pi/main`。

隔离回归使用真实 Host/SQLite/策略与受控的进程、Native 资格和传输边界。持久授权还通过独立 Node 进程、隔离 OS 账户 home 与生产可执行程序选择器验证；该检查不执行 client。Ovis/Wake 回归不等于真实桌面或云端验收。真实 Pi TUI 重启、云端、桌面、生产和长时间在线仍未验证；不承诺开机启动、无人值守重连或业务任务恢复。
