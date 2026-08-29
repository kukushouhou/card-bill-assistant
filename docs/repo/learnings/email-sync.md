# 邮件同步状态域经验

> MailLog 状态写入值域、营销黑名单与借记卡综合对账单落库口径、历史 ignored 行处置、同步汇总与 API 过滤。

---

## MailLog 状态写入值域

- **性质**: 约定
- **背景**: 原 MailLog 存在 `ignored` 独立状态（营销黑名单命中、借记卡综合对账单命中两条路径写入）。用户决策取消该独立状态，新写入口径统一归入 `unmatched`。
- **内容**: `MailLog.status` 新写入值域为 `'matched'` / `'unmatched'` / `'image'` / `'error'` 四档。`'ignored'` 不再被任何代码路径写入。Prisma schema 保持 `String @default("unmatched")`，无 enum，无 migration。

## 营销黑名单命中记 unmatched

- **性质**: 约定
- **背景**: 原营销黑名单（`isBlacklisted`）命中后 `MailLog` 记 `status='ignored'`，与 `unmatched`（解析器未命中）区分。用户决策取消独立 `ignored` 状态，黑名单命中归入 `unmatched`。
- **内容**: `isBlacklisted(from)` 命中后 `MailLog` 记 `status='unmatched'`，不写 `parserId`，不写 `error`，不拉正文（不调用 `fetchMailContext`），不解析。同步计数累加到 `summary.unmatched` / `state.unmatched`（不再累加到 `ignored`）。`isBlacklisted` 函数本体与 `BLACKLIST_DOMAINS` 数组保留不变；营销邮件不入白名单硬约束继续生效。

## 借记卡综合对账单记 unmatched 不写 parserId

- **性质**: 约定
- **背景**: 原 `isDebitOnlyStatement` 命中后记 `status='ignored'` 且写入 `parserId`。用户决策与黑名单命中同路径归入 `unmatched`，且 `parserId` 不写。
- **内容**: `isDebitOnlyStatement(mail)` 命中后 `MailLog` 记 `status='unmatched'`，不写 `parserId`，不写 `error`。同步计数累加到 `unmatched`。与「解析器未命中 → `unmatched`」路径同一口径。`isDebitOnlyStatement` 函数本体保留不变。

## 历史 ignored 行不动 + 脏代码全清

- **性质**: 约定
- **背景**: 库中存在 9 条历史 `MailLog.status='ignored'` 行。用户决策不清理历史脏数据，但新代码中必须完全清除 `ignored` 概念。
- **内容**: 历史 9 条 `status='ignored'` 行保持原样，不回填、不改写、不迁移。新代码中不得保留任何针对 `'ignored'` 的过滤、映射或字段：`SyncSummary.ignored` / `HistorySyncState.ignored` 字段整体移除；`STATUS_TAG` 映射移除 `ignored` 键（历史行 Tag 回退显示原始字符串 `'ignored'`）；`syncSummaryText` 移除「忽略 N」拼接；服务端 `console.log` 移除「忽略 N」拼接段；历史拉取弹窗移除「已忽略：N」拼接；Checkbox 标签从「显示未匹配/已忽略」改为「显示未匹配」。

## 同步日志 API 默认过滤与汇总类型

- **性质**: 约定
- **背景**: 原 `GET /api/email/logs` 默认排除 `['unmatched', 'ignored']`，`SyncSummary` / `HistorySyncState` 含 `ignored: number` 字段。取消 `ignored` 状态后需同步收缩。
- **内容**: `GET /api/email/logs` 默认 `notIn` 从 `['unmatched', 'ignored']` 收缩为 `['unmatched']`。`includeUnmatched=1` 机制继续生效（移除默认 `notIn`，显示全部）。历史 9 条 `ignored` 行不在 `notIn: ['unmatched']` 范围内，默认视图可见，Tag 回退显示原始字符串 `'ignored'`（用户决策接受此副作用）。`SyncSummary` / `HistorySyncState` 类型移除 `ignored: number` 字段，计数并入 `unmatched`。前端 `syncSummaryText` 仅输出「匹配 N」「未匹配 N」「图片 N」（>0）「错误 N」（>0）四档。服务端日志行改为 5 档拼接（`新增` / `匹配` / `未匹配` / `图片` / `错误`），不含「忽略」。
