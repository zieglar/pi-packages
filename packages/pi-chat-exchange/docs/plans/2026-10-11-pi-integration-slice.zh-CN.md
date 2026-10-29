[English](./2026-10-11-pi-integration-slice.md) | [简体中文](./2026-10-11-pi-integration-slice.zh-CN.md)

> 历史计划（2026-10-11）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="b3-p3b-real-two-process-pi-runtime-experiment"></a>

# B3-P3B 真实双进程 Pi 运行时实验

日期：2026-10-11
阶段：CE-0002 B3-P3B
前提：`pnpm --dir packages/pi-chat-exchange run build`（扩展从 `packages/pi-chat-exchange/dist` 导入编译后的 Host 接缝）。

<a id="isolation-rules"></a>

## 隔离规则

- 使用独立的临时 HOME 和工作目录；不接触生产 `~/.pi` agent 目录、凭证、会话或扩展安装。
- 使用独立临时 CE Store 目录，由扩展在首次使用时创建，包括 host-secret 制品。
- 将被测扩展复制到临时工作目录的 `.pi/extensions/ce-chat-exchange/`。它通过相对路径导入软件包 `dist`，因此需要修改副本，使其指回仓库 checkout。

<a id="setup"></a>

## 准备

```sh
REPO=/path/to/ce-checkout
TMP=$(mktemp -d /tmp/ce-p3b-smoke-XXXXXX)
mkdir -p "$TMP/home" "$TMP/work" "$TMP/store"
cp -r "$REPO/.pi/extensions/ce-chat-exchange" "$TMP/work/.pi-extensions-src"
mkdir -p "$TMP/work/.pi/extensions"
cp -r "$TMP/work/.pi-extensions-src" "$TMP/work/.pi/extensions/ce-chat-exchange"
# point the copied extension at this checkout's compiled seam
perl -pi -e "s{\\Q../../../packages/pi-chat-exchange\\E}{$REPO/packages/pi-chat-exchange}" \
  "$TMP/work/.pi/extensions/ce-chat-exchange/index.ts"

cat > "$TMP/allowlist.json" <<'JSON'
{
  "exchangeNamespace": "pi-local",
  "exchangeIdempotencyKey": "pi-local-exchange",
  "leaseTtlSeconds": 600,
  "sessions": {
    "ceA": { "endpointId": "local/sessionA" },
    "ceB": { "endpointId": "local/sessionB" }
  }
}
JSON
```

<a id="checks-record-observed-output-never-infer"></a>

## 检查项（记录实际输出，不作推断）

1. **扩展加载，身份不同。** 在两个终端中执行，或执行两个共享 `$TMP/store` 的连续 `pi -p`：

   ```sh
   cd "$TMP/work"
   env HOME="$TMP/home" CE_STORE_DIR="$TMP/store" CE_ALLOWLIST="$TMP/allowlist.json" \
     pi --session-id ceA -p "Reply with exactly: ready-A"
   env HOME="$TMP/home" CE_STORE_DIR="$TMP/store" CE_ALLOWLIST="$TMP/allowlist.json" \
     pi --session-id ceB -p "Reply with exactly: ready-B"
   ```

   证据：`$TMP/home/.pi/agent/sessions/...` 下存在会话文件，会话头不同（`"id": "ceA"` 与 `"ceB"`）；各自包含 `ce-mapping` 自定义条目，两个 `sessionId` 是不同的 `ses_…` ID。

2. **获得授权的 A 发送。** 要求 A 的模型调用 `ce_send`，参数为 `to: "local/sessionB"`、`text: "hello from A"`、`idempotencyKey: "smoke-1"`。证据：工具返回 `created` 及 `msg_…` ID；持久 Store 恰好有一条消息行。
3. **获得授权的 B 读取元数据。** 要求 B 的模型用步骤 2 的消息 ID 调用 `ce_read`。证据：返回元数据（`from local/sessionA`、长度 12、sha256 摘要），结果中没有 payload 文本。
4. **读取权限不能用于发送，错误接收方不能读取。** B 向 A 的 `ce_send` 只有使用 B 自身权限才成功（允许，因为 B 持有 send capability）；B 读取发给 A 的消息时返回不透明的 `MESSAGE_READ_REJECTED`。证据：工具结果中的拒绝文本。
5. **所有权过期后拒绝。** 等待租约过期，或使用较短 `leaseTtlSeconds`，再调用 `ce_send`；证据：`CE_HOST_AUTHORITY_ABSENT`。
6. **Reload 不重复注册 handler。** 在交互会话中执行 `/reload`，然后 `/ce-status`；证据：恰好一条 binding 通知和一条干净状态行。运行时使旧 extension runner 失效；扩展不注册 timer 或 watcher。
7. **重启不静默重建权限。** 在租约内为 `ceA` 重跑步骤 1：重新接纳 mapping，`ce-status` 报告相同 CE Session。租约过期后，`ce-status` 报告 `registered=true`，但操作以 `CE_HOST_AUTHORITY_ABSENT` 拒绝。
8. **Cursor 不变。** 全部步骤前后，`SELECT count(*) FROM delivery_cursor;` → `0`。
9. **没有凭证泄漏。** 对会话文件、扩展 Store 目录文本制品及捕获的 pi 输出执行 `grep -rE 'cap_[0-9a-f]{64}' "$TMP"`，没有匹配。

<a id="cleanup"></a>

## 清理

```sh
rm -rf "$TMP"
```

<a id="not_run-policy"></a>

## NOT_RUN 策略

若任何步骤无法在隔离环境中安全执行，例如没有可供 `-p` 驱动工具的模型 provider 凭证，或没有 tmux 可做交互 reload 检查，应在报告中标为 NOT_RUN。不得用 mock 或单元测试替代真实运行时主张。

<a id="observed-results-2026-10-11-isolated-env-pi-0861-on-node-24210"></a>

## 观察结果（2026-10-11，隔离环境，Node 24.21.0 上的 pi 0.86.1）

工具驱动运行使用 `zai-coding-cn/glm-5.3`；交互 `/reload` 检查（步骤 6）使用默认订阅模型，不需要推理，其证据由扩展/命令生成。

所有步骤在 `/private/tmp/ce-p3b-smoke-*` 环境中执行，通过 `PI_CODING_AGENT_DIR` 隔离；生产 `~/.pi` 未改动。模型为 zai-coding-cn/glm-5.3，anthropic/openai-codex provider 受到配额限制。

1. 两个进程都加载了扩展；Pi 会话头为 `ceA`/`ceB`；CE Session 为 `ses_<SESSION_A>` / `ses_<SESSION_B>`；participant 不同，共享 Exchange `ho_<EXCHANGE>`。
2. A `ce_send` → `msg_<BEFORE_JOIN>`（CREATED）。
3. B 对该 ID 的 `ce_read` 被 `MESSAGE_READ_REJECTED` 拒绝：消息早于 B 的加入边界，符合 P3A 语义。B 加入后的第二次发送（`msg_<AFTER_JOIN>`）读取成功：来自 `local/sessionA`，13 字节，仅元数据，没有 payload 文本。
4. 发送方读取接收方消息以及读取不存在的 ID，都得到相同且不透明的 `MESSAGE_READ_REJECTED`。
5. 租约过期后，发送如实返回 `CE_HOST_AUTHORITY_ABSENT (LEASE_EXPIRED)`；持久消息数为零。完整历史位于环境 `/private/tmp/ce-p3b-expiry/`：前两次尝试（`exp-1`、`exp-2`，使用启动失败修复前的扩展副本）返回误导性的 `CE_HOST_NOT_REGISTERED`；扩展修复了该缺陷，失败 `resume` 现在原样报告启动失败。修复后的第三次尝试（`exp-3`）产生此处记录的真实 `LEASE_EXPIRED` 拒绝。
6. `/reload` 使用交互 `ceE`，仅对 smoke 副本插桩，仓库扩展没有插桩。持久制品 `/private/tmp/ce-p3b-smoke-<RUN>/evidence-reload/marker.log` 精确记录 `factory-run`、`session_start reason=startup`、`factory-run`、`session_start reason=reload`：一次重新求值，无重复 handler；`4-status-after.txt` 显示 reload 后 `/ce-status` 报告相同 CE Session（`ses_<RELOAD_SESSION>`，租约 ACTIVE）。Reload 从 SessionManager 的内存 branch entry 重新接纳 mapping（`pi.appendEntry` 在没有会话文件时仍跨 `/reload` 保留；不存在 `ceE` 会话文件，持久 Store 恰好一条 binding 和一条 ownership 行）。此前一次未插桩尝试产生矛盾 transcript：符号链接损坏导致扩展未加载，模型随后从会话历史幻觉出工具可用性。因此弃用该次尝试，采用此插桩运行。
7. 租约内重启恢复相同 CE Session，4 条 `ce-mapping` 的 session ID 一致；过期后重启拒绝恢复权限。
8. 全部步骤前后 `SELECT count(*) FROM delivery_cursor` = 0。
9. 对整个 smoke 目录树（会话文件、Store 制品、捕获输出）执行 `grep -rE 'cap_[0-9a-f]{64}'`，零匹配。

运行时发现已反馈到实现：（a）adapter/Host 要求精确 Node 24.21.0，除非 `PATH` 前置 24.21.0 bin 目录，否则 pi shim 使用系统 Node；（b）失败 `resume` 现在向工具返回 `CE_HOST_AUTHORITY_ABSENT`，不再给出误导性的未注册拒绝；（c）模型可能根据恢复的会话历史声称工具可用，只有真实工具调用才是证据。
