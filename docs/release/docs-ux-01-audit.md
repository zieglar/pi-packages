# HANDOFF-PI-CE-DOCS-UX-01 — Public Documentation Audit & UX Refresh

包含执行中 Scope Patch01，沿用原 Handoff。日期：2026-10-30 本地 / 2026-10-29 UTC。Verdict：**ACCEPT WITH FOLLOW-UP**。PX-0020 已正常推送，精确 SHA Hosted CI 全部成功；Public 文档静态验收完成，真实 Cloud 端到端尚未执行。保留本地harness首次来源白名单失败及有界补充核验，不将其改写成完整端到端PASS。

## 基线与授权

Private main 起点 `2e75e45d3e12dbf1a68ba064b0152624a65b258d`，Public main / PX-0019 `c7e2f0f756cd1868f175bde8743cef9920fbc6b8`。实际 fetch 两次确认远端未漂移后才准备/推送。Private upstream origin/main 起始160 ahead/0 behind；Export branch `export/ce-native-default-01` 无 upstream，显式比较 origin/main；原 Public `verify/ce-public-ci-03` 仍为 `86e0efa21645f429aa014b4d5fe2ac68d95434ad`、0/0、干净。根目录、branch/HEAD、worktrees、remote/upstream/ahead-behind 和状态见外部 baseline.json。保留用户未跟踪 AGENTS.md、.herdr-web-ui/ 和其他 worktree。

Registry 实际读取 `@zieglar/pi-chat-exchange@0.2.1`，确认版本、integrity 与 GitHub OIDC trustedPublisher metadata；既有发布 run40925828108 和候选CI40925049158 的结论沿用上一轮原始证据，没有重复 publication。当前 handoff 只授权文档、Private commit、Public Export/FF push/CI，不授权 npm、Native Release、真实 Tunnel、生产配置或真实消息。

## 完整文档清单与信息架构

Public CE 包内48份 Markdown，即24组英中页面。REWRITE8、UPDATE22、KEEP16、HISTORICAL2。实际修改30份，其余18份原样保留。仓库根级两个 README 不计入CE48份，但链接脚本也覆盖它们，所以 Public 检查总数50；Private全树检查112文件/56双语组，额外含未导出的历史证据。首次 Public 数量断言误用48而非50中止了预推送脚本；纠正统计范围后通过，没有更改文档或跳过检查。

层级分布 P0=6、P1=10、P2=6、P3=26。P0 是首页、Getting Started、Installation；P1 是 Native/Tunnel/Desktop/多Session任务；P2 使用现有 Pi reference/runtime/troubleshooting/profile 页；P3保留架构、契约、安全、发布工程与历史。现有 documentation 双语索引统一四层导航，未新增空页面或重复文档系统。

| Public 包内路径 | 层级 | 分类 | 处理理由 |
|---|---|---|---|
| `CHANGELOG.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `CHANGELOG.zh-CN.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `README.md` | P0 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `README.zh-CN.md` | P0 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/architecture.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/architecture.zh-CN.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/chatgpt-installation.md` | P1 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/chatgpt-installation.zh-CN.md` | P1 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/delivery-ack-contract.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/delivery-ack-contract.zh-CN.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/documentation.md` | P2 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/documentation.zh-CN.md` | P2 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/getting-started.md` | P0 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/getting-started.zh-CN.md` | P0 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/independent-install.md` | P0 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/independent-install.zh-CN.md` | P0 | REWRITE | Task-first entry and bilingual navigation; legacy evidence kept separately |
| `docs/licenses.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/licenses.zh-CN.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/multi-session-usage.md` | P1 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/multi-session-usage.zh-CN.md` | P1 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/native-management.md` | P1 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/native-management.zh-CN.md` | P1 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/native-release-ci.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/native-release-ci.zh-CN.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/native-sqlite.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/native-sqlite.zh-CN.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/operations.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/operations.zh-CN.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/ownership-contract.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/ownership-contract.zh-CN.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/protocol-v2.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/protocol-v2.zh-CN.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/releases/0.2.0.md` | P3 | HISTORICAL | Version-specific0.2.0 release record retained verbatim |
| `docs/releases/0.2.0.zh-CN.md` | P3 | HISTORICAL | Version-specific0.2.0 release record retained verbatim |
| `docs/runtime-support.md` | P2 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/runtime-support.zh-CN.md` | P2 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/storage-contract.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/storage-contract.zh-CN.md` | P3 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/storage-security.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/storage-security.zh-CN.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/tunnel-manager-background.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/tunnel-manager-background.zh-CN.md` | P3 | KEEP | Accurate scoped contract/feature/history; no correction needed |
| `docs/tunnel-setup.md` | P1 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `docs/tunnel-setup.zh-CN.md` | P1 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `pi-extension/README.md` | P2 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `pi-extension/README.zh-CN.md` | P2 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `plugin/pi-chat-exchange/README.md` | P1 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |
| `plugin/pi-chat-exchange/README.zh-CN.md` | P1 | UPDATE | Correct current version/runtime/release evidence; preserve technical contracts and historical body |

分类按最终实际处理计，scout 初步建议不机械采纳：CHANGELOG 已有准确0.2.1范围，保持不变；冻结/历史契约不因当前软件版本而改写。Storage仅加当前读者说明，不宣称旧候选审批已完成。独立安装页增加当前流程，历史正文逐字保留。

## 主要用户体验修复

README由完整手册压缩为用途、能力、平台/证据限制、最短安装、Native入口和GettingStarted链接。GettingStarted分十步：用途、前提、安装、Native、Setup、ChatGPT、双向首次消息、验证/停止、排障、专题。各步标注系统终端/PiTUI/ChatGPT，给出可观察成功条件和失败入口。

普通入口使用已发布 `pi install npm:@zieglar/pi-chat-exchange@0.2.1`，不要求克隆/编译/独立Host。专用Host和Registrytarball放入独立安装页当前前缀，历史0.2.0正文隔离且不改字节；当前0.2.1下载hash来自真实Registry制品，不把文档修改当作重发包。源码开发留operations；Desktopstdio与Tunnel明确分开，不要求Tunnel用户安装Desktop插件。

源码核对：`setup-ui.ts` 常量确为 `chatgpt/main`、`pi/main`；`CeEndpointHost.#recipient` 按 endpointId 精确查找，`ce_send.to` 不拼接adapter。AdvancedRecipients的 `adapter:endpointId` 和Recovery的 `<adapter>/<endpointId>` 是独立格式。文档没有虚构recipient。工具ping真实名为 `ping`，不是ce_ping；Pi有metadata-only ce_read，MCP没有。sendto/text/idempotencyKey、boundedInbox、messageIdread、ACK四字段及MCP auditSequence映射均对照实现。

Native明确MISSING时Pi管理仍可用、Store/messaging/Start拒绝；显式install后完整重启，再verifyREADY。Client单独取得/核验，CE_NODE_PATH只选择child，backgroundoptin要在父进程设置。Setup通过精确AdvancedMessaging菜单授权两端发送/payload/ACK，然后Save；同Sessionreload→显式activate→ce-statusleaseACTIVE→单独Start。旧配置先Stop核实STOPPED，必要时正常deactivate；owner/release未知不靠循环activate/reset解决。

首次交换是明确授权的工具调用示例，每逻辑消息唯一runkey，保留原key/MessageID，不把收到的文字当新权限。ACK仅reception，不证明delivery/read/processing/completion；缺ACK、timeout、unknown不授权换key重发，也不将DELIVERY_UNKNOWN改为CANCELLED。双向读取成功证据与Configured/Pi-bound/CONNECTED/ping分离。安全Stop明确退出Pi/关闭Manager不会结束detachedclient，必须Stop并核实状态；deactivate不是Stop。

其他当前过期说明已修正：错误Node24窄范围、Nativepins为null/尚未发布、默认node-sqlite、npmworkflow本地未推送、LinuxHosted未验证、DesktopZIP0.2.0。0.2.0旧发布说明、CHANGELOG历史及冻结规范不伪造成0.2.1验收。Tunnel旧恢复命令未引号包围的<占位符>会被shell当作重定向，已仅加单引号，所有flag与安全前提不变。

## 验证及证据范围

- 初始定向153/153，覆盖发布准备/pack、SetupMessaging、binding/config、Pi激活、MCP工具与ACK、Nativecommand。后续改了pack相关README及Installation，必要27/27 release/distribution复验；未为扩大范围重跑仍有效的其余126项。workspace2packages通过。已有mockhoist未来警告保留，无代码修复。
- Markdownfence平衡、22JSON块解析、55shell块bash-n通过。首轮找到的恢复占位符错误已修正，首次失败保留。gitdiffcheck通过。无单独repoMarkdownlint脚本，未安装额外工具。
- Public实际48CE+2root页面：0缺失语言对/0坏语言切换/0断文件或fragment链接/0隐私命中。Private112页面也无断链，两个旧计划中的字面/Users/泛称匹配属于未导出历史记录，不当作泄漏。另将34个GitHubblob/main链接映射到本地文件/fragment，0错误。外部服务页面资格/UI按官方文档链接，不冒充实时Cloud验证。
- README/GettingStarted/Installation两语fenced命令和JSON逐字一致；其余页命令/标识人工对照。架构和Tunnel既有块差异是旧注释/语言形式，保留并检查语义；不为逐字一致改冻结规范。中文正文优先对应中文链接，双语索引的English列是明示的跨语言导航。旧入站中文平台锚点补回，避免标题调整断链。
- 仅30Markdown路径，源码/测试/锁文件/Nativepins/workflowblob未改。历史install正文、Storage原正文保护检查通过；KEEP/HISTORICAL18份与基线blob相同。

隔离本地补充验证使用真实Registry0.2.1、Pi1.3.0、Node22.19.0、macOSarm64、全新私有HOME，未复制预备cache。生产runNativeCommand得到MISSING→显式下载校验0.1.0并提示restart→新进程READY；随后真实PiTUI验证ce-nativeverifyREADY、doctor、masked合成Setup、reload/activate/deactivate/normalexit0，profile/policy/mutex/Store持久检查全部0。外部诊断wrapper复用原harness，无仓库测试改动。

原harness最终整体FAILED，原因必须保留：其originallowlist仅在预复制driver_home模式才放行私有Nativecache，本轮通过真实install新建的同一cache在CJS/fileURL两次被判outside。补充只读核验确定仅这两条路径、均为本轮私有HOME固定0.1.0cache且sha256=b3b0102931f4fd50459e435cd0ac3ad68f61f9c00c0c14366eb03ab5f4b71db3，与生产pin一致，无其他escape。RegistrylockURL/integrity正确、Pi退出0和四项durable检查通过。单列补充结论PASS只覆盖这些本地步骤，不把原结果改成PASS。未重复安装/全矩阵来抹掉首次失败。

本轮**没有**真实TunnelStart、真实云凭据/消息/ACK或完整Cloud端到端Dogfood；保留NOT_VERIFIED。没有扩大Windows、WSL2、Linuxarm64Store、DesktopUI或未来Node支持承诺。环境来源校验harness的残余条件是测试工具限制，不是实现变更或云验收证据。

## 固定候选与独立审查

Private文档提交 **bf9f68b991e9eb44303430af75e6abd30af9b8d6**，基线2e75e45，30Markdown文件。编辑采用本地humanizer/qu-ai-wei内嵌步骤，命令/事实/权限优先，未安装第三方脚本。scout只读初审返回REWORK的旧状态已核查；其将工程问题标成P0是修复优先级，最终信息架构仍按用户读者层级分类。

reviewer **docsux-review / reviewer / magpie/group/smart-split / low / standalone** 返回PASS，独立核对30文件、48实际清单、历史正文保护、双语块、Setup/reload/activate、recipient和ACK语义。它没有联网查Registry/CI或重跑父级测试，限制保留。路由底层家族未知，不声称跨家族/两人独立审查。review-pass.json含完整固定SHA与session。

## Export 与 Push

Public **PX-0020 7c3d2f0ac9f97195bd9440ae3981e28bafcc8f82**，直接父PX-0019 **c7e2f0f756cd1868f175bde8743cef9920fbc6b8**。30/30文件blob精确等于Privatebf9f68b；Private历史/Skills/审计/Ledger不进入Public。Ledger逐路径sourcecommit/blob/targetbaseblob/contentdigest记录。预推送59events20exports的Gitprovenance/schema/transition/digest通过，五项负向5/5。

再次fetch确认远端仍PX19且本地1ahead/0behind、clean，正常push仅`7c3d2f0ac9f97195bd9440ae3981e28bafcc8f82:refs/heads/main`，push.followTags=false。ls-remote/fetch确认远端精确PX20。Public所有文档链接/隐私通过。无tag/Release/npmPublish/PR/merge/reset/rebase/force/真实transport或生产配置操作。

## CI 与最终收尾

精确 **CI run40932992664**，attempt1，https://github.com/zieglar/pi-packages/actions/runs/40932992664 ，workflowCI/eventpush/branchmain/head **7c3d2f0ac9f97195bd9440ae3981e28bafcc8f82**，completed/success。validate job123656066360 的workspace/build/typecheck/check/test/diff hygiene全部实际成功；2856passed/24existing skipped/0failed，174passedfiles/2skippedfiles。Native22.19.0 job123656065839与Native24.22.2 job123656066270各227/227、15files、无skip/failure。没有重跑CI，也没有用旧SHA替代。候选Push后仅写Private审计/Ledger，Public保持该精确SHA。

最终Ledger **61events/20exports**，只追加PX20 PENDING_EXPORT/COMMITTED/PUSHED/CI_VERIFIED，既有57event前缀不变。收尾再次检查Gitprovenance/schema/transitions/digests、Private受控变更、Publicmain与Registry0.2.1事实。无npmPublish/NativeRelease或其他外部发布。下一步仅为另行授权的真实Cloud首次交换验收，以及可选的隔离诊断harness缓存来源建模改进；不在本轮改测试或启动真实Tunnel。

外部证据目录 `/Users/zieglar/Code/Pi-Project-Evidence/chat-exchange/docs-ux-01/`，包含baseline/Registry、48fileinventory、implementationmap、153targeted和27necessaryrerun、完整链接/语法/历史保护/隐私、source/archive、localharness首失败与补充、fixedreview、PX20events/路径、Ledgernegative、push及精确CIJSON/rawlogs。文档清单逐份可审阅；没有把Private证据链接放到Public用户流程。
