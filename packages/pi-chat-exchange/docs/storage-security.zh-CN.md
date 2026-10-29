[English](storage-security.md) | [简体中文](storage-security.zh-CN.md)

# 私有存储安全边界（CE-0002-B1-R4）

> 历史基础阶段及后续 P1A 补充记录。下文的延后事项和版本声明属于各自阶段；当前持久存储支持范围见 [storage-contract.md](storage-contract.zh-CN.md)。

这是私有 SQLite 基础设施，不是投递/dispatch 实现。公开协议和生命周期词汇不变。

已接受的持久存储综合契约（CE-0002-B2-S6-2）见 [storage-contract.md](storage-contract.zh-CN.md)。

## 不可变性与兼容性

每个 writer 都启用并读回 `recursive_triggers=ON`。这会使冲突的 `INSERT OR REPLACE` 删除触发 Result、audit、migration ledger 和 store identity metadata 上现有的不可变行 trigger。文件存储测试覆盖主键和次级唯一键冲突，以及 UPDATE 和 DELETE。原始连接的所有者不得禁用该策略。

重新打开时，将完整、有序的 `sqlite_schema` 清单（`type`、`name`、`tbl_name`、`sql`，包括隐式索引）与由已批准迁移 SQL 独立构建的参考清单比较。不比较 root-page 布局。SQL 不做空白规范化：即使语义等价，未授权 DDL 也不兼容。检查覆盖列、STRICT/CHECK/FK/UNIQUE 约束、trigger、索引、额外 table 和 view。版本与 migration-ledger 检查仍彼此独立。漂移会被拒绝，绝不修复或迁移。

## 文件系统与拒绝

所有目录组件必须是真实目录，任何祖先目录都不得是符号链接。使用规范 OS 路径（例如在创建私有目录前先规范化临时根目录；macOS 的 `/var` 和 `/tmp` 别名是符号链接）。最终目录必须由当前用户拥有，权限为 0700，并位于已批准的本地文件系统。使用 `lstat` 检查 DB/WAL/SHM 制品，包括悬空链接；制品必须是当前用户拥有、权限为 0600 的普通文件。新数据库文件使用独占创建和 `O_NOFOLLOW`。初始化不能覆盖竞争中已出现的名称。这些检查在 SQLite 打开路径前执行。

已有 store 先经过不修改原件的**只读快照预检**。仅用 SQLite `readOnly` 打开原件还不够：WAL 共享内存制品仍可能被修改。私有临时目录保存 DB 和存在时的 WAL 副本；SQLite 只以只读方式打开副本。复制的 WAL 会被读取，不会忽略；SHM 在临时目录内重建。存在 rollback journal 时拒绝，不进行隐式恢复。正常成功/失败时删除快照制品。测试对被拒绝的 store 比较原始 DB/WAL/SHM 的精确字节和目录清单，包括存在 live WAL writer 的情形。不改变被拒绝 DELETE store 的 journal mode。

预检成功后，在持久 writer 策略生效前，先于读事务内重新校验所选原件的 identity、restore hold、version、ledger、live schema 和 integrity；返回句柄前再次校验。UUID 改变或源文件消失均被拒绝。

**限制：**DB/WAL 复制不是原子备份。并发修改可能导致保守拒绝。祖先/制品检查、复制、SQLite 路径打开及 writer 设置都有 TOCTOU 窗口；writer 重新校验只能减少，不能消除竞争。Node 的 SQLite 绑定不接受预先打开的 no-follow descriptor。要求可信父目录，以及由操作者控制 store 命名空间。拥有同等文件系统权限的攻击者可以替换路径或数据库内容；不声称完全防御此类攻击者、mount 替换或断电持久性问题。快照 I/O 和启动扫描预算仍延后（F8）。

## 事务所有权与结果

`withImmediateTransaction` 保持同步。回调获得冻结、可撤销的句柄，仅暴露 `exec` 和 `prepare`；其冻结 statement 仅暴露同步 `run`、`get` 和 `all`。句柄不返回原始连接、authorizer、事务控制或 iterator。SQLite 原生 authorizer 在回调期间拒绝解析后的 transaction/savepoint action，包括捕获或预准备的原始连接 COMMIT/ROLLBACK statement。即使拒绝被吞掉，操作仍会失败并回滚。

正常返回表示 **COMMITTED**。事务错误携带 `outcome` 和 `retryable`：**ROLLED_BACK** 要求已知无写入的 begin 失败或已验证的受控回滚；意外 inactive/不可读状态、不确定 commit 或未经证明的清理均为 **INDETERMINATE**，不可重试，并使连接失效/关闭。仅在已知回滚/无写入结果下的 SQLite busy 错误可重试。Busy 等待保持有界；独立进程 writer 测试检查这一点。SQLite extended busy code 按 primary code 分类。

该原语在执行期间拥有连接 authorizer。原始私有 store 连接是特权 setup/test 权限，不是回调 capability。蓄意替换其 authorizer 或使用独立特权连接不在防护边界内；仍会保守检测意外事务状态。独立特权连接不受沙箱限制。

回调返回契约为 **void-only**：运行时只接受恰好为 `undefined` 的返回值。不接受其他 primitive、object、function、Promise 或 thenable。不受支持的结果导致同步回滚和 capability 撤销。拒绝 object 时不读取 `.then`、不调用 getter/Proxy trap，也不吸收 thenable。仅靠 TypeScript 的 `void` 回调类型不能强制此规则。

helper 不安装任何全局 runtime 观察机制。不安装 V8 Promise hook 或 `async_hooks`，不附加 Promise reaction，不改变进程 rejection 处理，也不消费无关 Promise rejection。对不受支持的返回值，只按身份与 `undefined` 比较：不读取、调用、await、吸收或修改。strict-mode 子进程测试断言：无关的 unhandled rejection 无论创建于事务回调内部还是外部，行为相同。

**Promise 所有权边界：**回调创建并返回 Promise 时违反同步事务契约。helper 保证对不受支持的返回值同步回滚；不保证处理调用方代码创建的 rejected Promise。创建者负责 rejection 处理；调用方异步工作导致的 unhandled rejection 不属于事务提交失败。由于根本不观察 Promise，也不声称能安全观察任意恶意原生 Promise。

**边界：**异步 continuation 和保留的 statement 无法使用已撤销句柄，即使句柄后来被复用也不行；但脱离回调的异步工作仍继续运行，不受沙箱限制。恶意修改进程级 intrinsic，以及单独捕获的特权原始连接，仍在执行隔离边界之外。

F6 初始化失败制品恢复、F8 通用预算、F9 架构负向 oracle 加固，以及所有 B2 功能，在本阶段仍延后。

## Host 信任根（CE-0002-B3-P1A）

v2 store 在私有 store 目录中增加 `host-secret` 制品。它遵循与数据库文件相同的制品检查（真实普通文件、0600、当前用户拥有、无符号链接、使用 O_NOFOLLOW 独占创建），另加精确长度和十六进制编码检查；每次打开时都对照只追加的 `host_trust_root` fingerprint table 重新验证。明文 secret 绝不进入 SQLite、结果、错误或日志；仅持久化其 SHA-256 fingerprint。

secret 丢失或轮换只能通过显式操作者命令（`recoverTrustRoot`）恢复：不自动重新生成，不在正常打开时恢复，不静默覆盖，也不自动删除孤立制品。恢复追加新 generation 并撤销所有已有 capability，因此替换 secret 不继承任何权限。

**限制：**信任根沿用上述文件系统信任边界：拥有同等文件系统权限的攻击者可以一致地替换数据库和 secret 文件，trust-root fingerprint 无法检测此类攻击者。fingerprint 可以检测意外或部分替换，以及未同时改写数据库的未授权重置尝试。secret 文件创建和对应 SQLite commit 之间的崩溃窗口按默认拒绝处理（孤立制品会阻止重试，直到操作者显式删除），不会自行修复。
