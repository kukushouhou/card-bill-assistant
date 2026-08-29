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
- **内容**: 统计 / 待办 / 未来 14 天 / 走势各自独立 `useEffect` + 各自 `loading` / `error` 状态（`statsLoading` / `todosLoading` / `upcomingLoading` / `trendLoading` 及对应 error）。任一分区失败只影响该分区，其他分区正常展示。禁止用「统一 toast / 全页空白」替代分区级失败态。`MarkPaidModal` 标记成功后只刷新「待办」与「未来 14 天」；统计与走势不重拉。删除统一 `load()` 函数。
