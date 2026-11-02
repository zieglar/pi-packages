[English](daily-use.md) | [简体中文](daily-use.zh-CN.md)

# 恢复已配置的 CE 会话

本页描述 HANDOFF-CE-DAILY-UX-01 新增的 `/ce-tunnel connect` 与 `/ce-tunnel disconnect`。先加载包含这次修改的扩展；原先安装的 CE 0.3.0 不会因源码修改而自动升级。本仓库包元数据仍为历史 0.2.2 候选，本次没有改版本、发布或覆盖已安装包。

## 首次设置

1. 按 [Tunnel 设置指南](tunnel-setup.zh-CN.md)选择已有合法 profile、Store、Exchange、Tunnel 与凭据引用。已有配置不必重建。若使用非默认 profile，在启动 Pi 的外部环境明确设置 `CE_TUNNEL_PROFILE` 为其规范化绝对文件路径；不要同时加载两份 CE 扩展。
2. 使用批准 Node 启动 Pi，保持原有 Magpie 与扩展加载方式。用 Pi `/name` 命名这个会话，用 `/session` 核对它的身份。已有 `pi/main` 属于原注册会话；恢复那个会话即可，不要在新会话重新登记 `pi/main`。
3. 只有当前真实 Pi Session 尚未注册时才执行一次 [多会话注册](multi-session-usage.zh-CN.md)：明确 Stop 并核实 STOPPED，再 `/ce-tunnel register pi/你明确选择的独立名称`，核对 Store、Exchange、当前会话及权限后确认。需要正文或 ACK 才加 `--payload-read` 或 `--ack`。现有单会话配置可继续使用；只有需要多会话时才按指南显式 convert。不要重建 Exchange 来绕过注册问题。
4. 配置发布后 `/reload`，加载对应策略。缺少 mapping 的首次 reload 或已经正常结束的绑定可能显示 `CE_HOST_MAPPING_INVALID`；显式 connect 会请求合法激活，不丢弃旧历史，也不接管 Owner。
5. 为允许手动启动真实 Tunnel，在自己控制的外部 shell 配置中设置下面的函数一次。它只为新启动的父 Pi 进程提供原有许可，不启动 Tunnel，不改变 CE 权限架构，也不把凭据放进命令。

```sh
cepi() {
  CE_TUNNEL_BACKGROUND_ALLOW=1 pi --resume
}
```

此函数用于已按日常方式安装、可通过 `pi` 启动的批准运行时。若原来使用批准 Node 或专用 Pi 启动器，保留那条启动命令并只在前面加该环境变量；不要为了示例更换全局 Node、模型或扩展来源。需要指定非默认 profile 时，在函数中显式设置自己的 `CE_TUNNEL_PROFILE`，不从项目文件自动读取。取消这项日常启动许可可移除函数或移除其中的变量，并正常退出已带许可运行的 Pi。

环境许可仍由当前 Pi 进程持有，必须精确为 `1`。在 Pi 内的子 shell 执行 export 或 `/reload` 不能为父进程补上许可。CE 没有新增持久权限文件、布尔授权或自动启动。

## 每天使用

在原项目目录的外部终端运行 `cepi`，在 Pi 选择器中选回**同一已注册会话**。然后：

```text
/ce-tunnel connect
/ce-tunnel status
```

connect 先检查交互 TUI、进程启动许可、Native/运行时与已加载配置的一致性。已有绑定有效时保持它；需要新 CE incarnation 时沿用原激活确认、STOPPED 配置锁和 `requireUnowned`。确认后才启动已有 profile 的 Tunnel，或对已运行实例进行健康实测，不创建第二套 Tunnel、Session 或消息机制。

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

只想退出当前 Pi、让其他会话继续使用共享 Tunnel时，可正常退出或显式 deactivate；但下次需要新激活且共享 Tunnel 仍在运行时，当前架构要求操作者另行协调 Stop，再 connect。connect 不会替你中断共享实例。手动 Stop 可以打断进行中的 connect；没有自动重连或后台重试。

## 拒绝与剩余操作成本

- `CE_TUNNEL_BACKGROUND_UNAUTHORIZED`：正常退出，用外部启动函数恢复。不能靠重新输入密钥解决。
- 当前 Session 不在 allowlist：选回已注册会话；全新 Session 需要自己的明确注册。Endpoint 不猜测、不换绑，不把旧 Session ID 当成任意新会话的通行证。
- 未加载所选策略、profile/环境变化：显式 reload 后复核身份，不在旧 factory 中扩大权限。
- 需要激活但 Tunnel 运行或状态未知：查看 status，协调后显式 Stop 并核实 STOPPED，再 connect。
- Busy、过期 Owner、互斥或释放不确定：停止该恢复路径，按 [排障](tunnel-setup.zh-CN.md)核对精确证据；没有自动 takeover、Owner 删除或清理标记。
- 已绑定但启动失败：绑定保持已建立状态，传输失败单独报告。先检查 status，再作下一次明确操作；不自动解绑、重建 Tunnel 或重试。

本轮方案为 **ACCEPT WITH FOLLOW-UP** 路线：保留进程门禁，通过外部启动函数免去反复手输变量，通过一个 connect 入口减少激活/启动操作。仍需选择原 Pi 会话、在必要时确认激活；全新会话复用旧 Endpoint 和 CE 内部持久启动授权需要后续单独设计。

隔离回归使用真实 Host/SQLite/策略与受控的进程、Native 资格和传输边界；Ovis/Wake 回归不等于真实桌面或云端验收。本次未安装生产更新、执行 Cloud E2E 或验证长时间在线；不承诺开机启动、无人值守重连或业务任务恢复。
