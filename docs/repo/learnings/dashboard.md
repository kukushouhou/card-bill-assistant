# 首页/仪表盘域经验

> 首页分区布局、快捷入口、嵌入走势、待办色带。

---

## 首页分区与视觉层次

- **性质**: 约定
- **背景**: 原首页过于素净、单调，缺乏视觉层次与信息丰富度。
- **内容**: 首页落地方案：统计/待办/近期事项分区用浅底与阴影分开；统计卡加 AntD 图标（`CreditCardOutlined` / `PayCircleOutlined` / `ClockCircleOutlined` / `MailOutlined`）和 `valueStyle` 强调色 + 浅色背景；顶栏加「同步邮件」「卡片」「账单」快捷入口按钮（`navigate` 跳转）；嵌入缩小后的金额走势 `<TrendChart items={trend.items} height={80} />`；待办 `List.Item` 左侧加 4px 宽色带（逾期=红、今天=橙、未来=灰蓝）。复用既有 `GET /api/dashboard/summary` / `/api/reminders/todos` / `/api/reminders/upcoming?days=14` + 复用 `GET /api/bills/trend?months=6`，不新增 API。

## 四分区独立加载

- **性质**: 约定
- **背景**: 原首页用统一 `load()` 函数 + `Promise.all` 拉取四个分区数据，缺 `catch` 处理，任一分区失败导致全页空白无提示。
- **内容**: 统计 / 待办 / 未来 14 天 / 走势各自独立 `useEffect` + 各自 `loading` / `error` 状态（`statsLoading` / `todosLoading` / `upcomingLoading` / `trendLoading` 及对应 error）。任一分区失败只影响该分区，其他分区正常展示。禁止用「统一 toast / 全页空白」替代分区级失败态。`MarkPaidModal` 标记成功后 `reloadPaid` 实际刷新 stats + todos + upcoming（**含 `refreshStats`**）；仅走势不重拉。删除统一 `load()` 函数。

## 当前待还统计口径：全量未还清

- **性质**: 约定
- **背景**: 原「本期待还」统计卡仅按 `period === 当前月份` 过滤真实账单，遗漏逾期上期、未取得账单占位行和未还清固定/动态账单。用户决策改为全量未还清口径。
- **内容**: 仪表盘首页统计卡标题固定为「**当前待还**」，不再使用「本期待还」或「YYYY-MM 期未还」。统计口径为全量未还清：复用 `buildLedger` 未还清分桶（`paidStatus !== 'paid'`）作为唯一来源，含逾期上期真实账单、当期未还、未取得账单占位行、未还清固定账单（`fixed_bill`）和动态账单（`dynamic_bill`）。笔数按台账行计数，每张卡每期未还清算一笔，套卡不折叠，与「今日待办」计量口径一致。排除项仅两类：常规提醒（`businessType` 非 `fixed_bill` / `dynamic_bill`）与过期 30 天的占位行（由 `buildLedger` 内部过滤）。不按卡状态、账期、来源或占位与否排除任何未还清项。不新增 `overdueCount` / `overdueTotal` 等逾期维度字段。占位行与自定义账单金额为 `null` 时计入 `unknownAmountCount`，不计入 `unpaidTotal`。`currentPeriod` 对象保留，`period` 字段保留但前端不再引用为标题。
