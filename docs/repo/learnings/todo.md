# 待办池

> 仅存放用户逐项判定后授权记录的待修问题。未经用户逐项判定的审查建议不得写入本文件。

### P3 - secret 路由保存完整卡号后未调 recomputePrimary
- **发现时间**: 2026-08-24
- **问题说明**: `POST /api/cards/:id/secret` 保存完整卡号后未调用 `recomputePrimary`（plan §3.5.10 要求）。功能上为空操作——secret 路由不改 `priority` / `primaryManual` / `status`，`recomputePrimary` 输入不变，输出也不变。增量复审已标记为超出本次手术边界的遗留项。
- **验收要求**: 在 secret 路由加密写入完成后补调 `recomputePrimary`，与 plan §3.5.10 对齐。
