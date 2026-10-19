import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  emailAccount: { count: vi.fn(), findMany: vi.fn() },
  mailLog: { findMany: vi.fn(), findUnique: vi.fn() },
  card: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  bill: { findMany: vi.fn() },
  billCard: { findMany: vi.fn() },
  upgradePlan: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  upgradeTask: {
    findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  },
  upgradeTaskItem: {
    findMany: vi.fn(), createMany: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn(),
  },
  $queryRawUnsafe: vi.fn(),
  $transaction: vi.fn(),
}));

const parserMocks = vi.hoisted(() => ({ list: vi.fn(), tryParse: vi.fn() }));
const schedulerMocks = vi.hoisted(() => ({ wait: vi.fn() }));

vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/parsers/registry', () => ({
  listBusinessRelationshipParsers: parserMocks.list,
  listAccountBillParsers: vi.fn(() => []),
  tryParse: parserMocks.tryParse,
}));
vi.mock('../src/parsers/pipeline', () => ({ applyParsedBills: vi.fn() }));
vi.mock('../src/modules/email/email.service', () => ({
  acquireEmailAccountLock: vi.fn(),
  openAccountMailReader: vi.fn(),
}));
vi.mock('../src/lib/card-groups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/card-groups')>();
  return { ...actual, recomputePrimary: vi.fn() };
});
vi.mock('../src/jobs/scheduler', () => ({
  waitForScheduledJobs: schedulerMocks.wait,
}));
// 框架用例与 notice 迁移解耦：默认隔离 notice（inspect 不命中），notice 行为单独用例覆盖。
const noticeState = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/modules/upgrades/migrations/overdue-basis-notice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/upgrades/migrations/overdue-basis-notice')>();
  return {
    overdueBasisNoticeMigration: {
      ...actual.overdueBasisNoticeMigration,
      inspect: async (db: Parameters<typeof actual.overdueBasisNoticeMigration.inspect>[0]) =>
        noticeState.enabled ? actual.overdueBasisNoticeMigration.inspect(db) : null,
    },
  };
});

import { APP_VERSION } from '../src/version';
import { approveUpgradeTask, getUpgradePlan, initializeUpgradeState, submitUpgradeDecisions } from '../src/modules/upgrades/upgrade.service';
import { accountZeroBillsMigration } from '../src/modules/upgrades/migrations/backfill-account-zero-bills';
import { cardBusinessRelationsMigration } from '../src/modules/upgrades/migrations/card-business-relations';
import { repairStatements050Migration } from '../src/modules/upgrades/migrations/repair-statements-050';
import { isUpgradeBusinessBlocked } from '../src/modules/upgrades/upgrade.runtime';

function card(overrides: Record<string, unknown>) {
  return {
    id: 1,
    bankName: '平安银行',
    cardLast4: '----',
    displayLast4: '----',
    statementDay: 18,
    dueRule: 'offset',
    dueDay: null,
    dueOffsetDays: 19,
    ...overrides,
  };
}

describe('版本升级协调器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noticeState.enabled = false;
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    db.appSetting.findUnique.mockResolvedValue({ value: APP_VERSION });
    db.emailAccount.count.mockResolvedValue(0);
    db.upgradePlan.findFirst.mockResolvedValue(null);
    db.upgradeTask.findMany.mockResolvedValue([]);
    db.upgradeTask.findUnique.mockResolvedValue(null);
    db.upgradeTaskItem.findMany.mockResolvedValue([]);
    db.emailAccount.findMany.mockResolvedValue([]);
    db.mailLog.findMany.mockResolvedValue([]);
    db.card.findMany.mockResolvedValue([]);
    db.bill.findMany.mockResolvedValue([]);
    db.billCard.findMany.mockResolvedValue([]);
    db.upgradePlan.create.mockResolvedValue({ id: 8 });
    parserMocks.list.mockReturnValue([
      { id: 'icbc2026', bankName: '工商银行' },
      { id: 'pab2026', bankName: '平安银行' },
    ]);
  });

  it('同版本启动不执行历史迁移', async () => {
    const result = await initializeUpgradeState(true);
    expect(result).toEqual({ runtimeMode: 'ready', shouldResumeExecution: false });
    expect(db.mailLog.findMany).not.toHaveBeenCalled();
    expect(db.card.findMany).not.toHaveBeenCalled();
  });

  it('缺少版本号但存在邮箱绑定时按 0.1.0 进入迁移链', async () => {
    db.appSetting.findUnique.mockResolvedValue(null);
    db.emailAccount.count.mockResolvedValue(1);

    await initializeUpgradeState(true);

    expect(db.mailLog.findMany).toHaveBeenCalled();
    expect(db.appSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { key: 'installedVersion', value: APP_VERSION },
      update: { value: APP_VERSION },
    }));
  });

  it('缺少版本号且没有邮箱绑定时直接建立当前游标', async () => {
    db.appSetting.findUnique.mockResolvedValue(null);
    db.emailAccount.count.mockResolvedValue(0);

    await initializeUpgradeState(true);

    expect(db.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'installedVersion' },
      create: { key: 'installedVersion', value: APP_VERSION },
      update: { value: APP_VERSION },
    });
    expect(db.mailLog.findMany).not.toHaveBeenCalled();
  });

  it('只读入场条件不成立时不创建计划也不弹提示', async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: '0.1.0' });
    db.mailLog.findMany.mockResolvedValue([]);
    db.card.findMany.mockResolvedValue([]);

    const result = await initializeUpgradeState(true);

    expect(result.runtimeMode).toBe('ready');
    expect(db.upgradePlan.create).not.toHaveBeenCalled();
    expect(db.upgradeTask.create).not.toHaveBeenCalled();
  });

  it('仅有占位卡静默迁移时在启动阶段隐藏并推进游标', async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: '0.3.1' });
    db.card.findMany.mockResolvedValue([
      card({ id: 519 }),
      card({ id: 600, cardLast4: '1765', displayLast4: '1765' }),
    ]);

    const result = await initializeUpgradeState(true);

    expect(db.card.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [519] }, hidden: false },
      data: { hidden: true, isPrimary: false, primaryManual: false },
    });
    expect(db.appSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { value: APP_VERSION },
    }));
    expect(result.runtimeMode).toBe('ready');
  });

  it('主副卡入场条件成立时创建可选任务且不推进游标', async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: '0.1.0' });
    db.mailLog.findMany.mockResolvedValue([{ accountId: 1, uid: 10, parserId: 'icbc2026' }]);
    db.upgradeTask.create.mockResolvedValue({ id: 9 });

    const result = await initializeUpgradeState(true);

    expect(result.runtimeMode).toBe('optional_wait');
    expect(db.upgradeTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'card-business-relations-v1',
        mode: 'optional',
        status: 'awaiting_decision',
      }),
    });
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
    const created = db.upgradePlan.create.mock.calls[0][0].data.manifest;
    expect(created[0].summary).toBe('工商银行 · 共 1 封已识别的历史账单邮件');
    expect(created[0].summary).not.toContain('平安银行');
  });

  function storedPlan() {
    const tasks = [cardBusinessRelationsMigration, accountZeroBillsMigration].map((migration, index) => ({
      id: index + 1, planId: 8, key: migration.key, mode: migration.mode, toVersion: migration.targetVersion,
      migrationOrder: migration.order, title: '旧工程标题', description: '旧工程说明',
      executeLabel: '现在执行', ignoreLabel: '忽略迁移', status: 'awaiting_decision',
      payload: { banks: index === 0 ? ['工商银行'] : ['平安银行'] },
      total: 4, processed: 1, succeeded: 1, unchanged: 0, failed: 0, error: null, approvedAt: null,
    }));
    return {
      id: 8, fromVersion: '0.1.0', toVersion: APP_VERSION, status: 'awaiting_decision',
      hasRequired: false, error: null, startedAt: null, tasks,
      manifest: tasks.map((task) => ({ ...task, targetVersion: task.toVersion, order: task.migrationOrder, summary: null })),
    };
  }

  function supplementaryLinks(primaryId: number | null) {
    const august = new Date('2026-08-25T00:00:00+08:00');
    const september = new Date('2026-09-25T00:00:00+08:00');
    const orphan = {
      ...card({ id: 445, bankName: '广发银行', displayLast4: '6736' }),
      businessRole: 'supplementary', businessPrimaryId: primaryId,
      businessRelationDate: primaryId === 446 ? september : august,
    };
    db.card.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where?.businessRole === 'supplementary') {
        return (where.businessPrimaryId === null) === (primaryId === null) ? [orphan] : [];
      }
      if (where?.id) return [card({ id: 444, bankName: '广发银行' }), card({ id: 446, bankName: '广发银行' })];
      return [];
    });
    db.billCard.findMany.mockResolvedValue([{ billId: 101, cardId: 445 }, { billId: 102, cardId: 445 }]);
    db.bill.findMany.mockResolvedValue([
      { id: 101, cardId: 444, period: '2026-08', statementDate: august },
      { id: 102, cardId: 446, period: '2026-09', statementDate: september },
    ]);
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (
      where.task ? [{
        itemKey: 'card:445', processedAt: new Date('2026-10-18T10:00:00+08:00'),
        payload: { cardId: 445, bankName: '广发银行', primaryCardId: 444, statementDate: august.toISOString() },
      }] : []
    ));
  }

  it('已完成 0.7.0 且关联正确时不创建 0.7.1 计划，直接推进版本', async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: '0.7.0' });
    supplementaryLinks(446);
    expect((await initializeUpgradeState(true)).runtimeMode).toBe('ready');
    expect(db.upgradePlan.create).not.toHaveBeenCalled();
    expect(db.upgradeTask.create).not.toHaveBeenCalled();
    expect(db.appSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: '0.7.1' } }));
  });

  it.each([null, 444])('0.7.0 用户关联为 %s 时只创建 0.7.1 可选修复项', async (primaryId) => {
    db.appSetting.findUnique.mockResolvedValue({ value: '0.7.0' });
    supplementaryLinks(primaryId);
    expect((await initializeUpgradeState(true)).runtimeMode).toBe('optional_wait');
    expect(db.upgradeTask.create).toHaveBeenCalledTimes(1);
    expect(db.upgradeTask.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      key: 'supplementary-link-repair-v2', toVersion: '0.7.1', mode: 'optional', status: 'awaiting_decision',
    }) });
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it.each(['awaiting_decision', 'failed'])('接替尚未结束的 0.7.0 %s 计划，保留旧明细', async (status) => {
    const stored = storedPlan();
    stored.toVersion = '0.7.0';
    stored.status = status;
    stored.tasks = [{ ...stored.tasks[0], key: 'supplementary-link-repair-v1', toVersion: '0.7.0', status }];
    db.upgradePlan.findFirst.mockResolvedValue(stored);
    db.appSetting.findUnique.mockResolvedValue({ value: '0.6.2' });
    supplementaryLinks(null);

    expect((await initializeUpgradeState(true)).runtimeMode).toBe('optional_wait');
    expect(db.upgradePlan.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: stored.id }, data: expect.objectContaining({ status: 'superseded' }),
    }));
    expect(db.upgradeTask.create).toHaveBeenCalledTimes(1);
    expect(db.upgradeTask.create).toHaveBeenCalledWith({ data: expect.objectContaining({ key: 'supplementary-link-repair-v2' }) });
    expect(db.upgradeTaskItem.updateMany).not.toHaveBeenCalled();
  });

  it('旧计划未决定但关联已经正确时，接替旧计划且不再弹修复项', async () => {
    const stored = storedPlan();
    stored.toVersion = '0.7.0';
    stored.tasks = [{ ...stored.tasks[0], key: 'supplementary-link-repair-v1', toVersion: '0.7.0' }];
    db.upgradePlan.findFirst.mockResolvedValue(stored);
    db.appSetting.findUnique.mockResolvedValue({ value: '0.6.2' });
    supplementaryLinks(446);
    expect((await initializeUpgradeState(true)).runtimeMode).toBe('ready');
    expect(db.upgradeTask.create).not.toHaveBeenCalled();
    expect(db.upgradePlan.create).not.toHaveBeenCalled();
  });

  it('旧计划被接替后拒绝浏览器残留的旧执行请求', async () => {
    db.upgradeTask.findUnique.mockResolvedValue({
      key: 'supplementary-link-repair-v1', plan: { status: 'superseded' },
    });
    await expect(approveUpgradeTask('supplementary-link-repair-v1')).rejects.toThrow('更新计划已被新版本接替');
    expect(db.upgradeTask.update).not.toHaveBeenCalled();
  });

  it('重建计划时保留其他迁移已经确认的决定', async () => {
    const stored = storedPlan();
    stored.toVersion = '0.7.0';
    const approved = { ...stored.tasks[0], status: 'approved' };
    stored.tasks = [approved, { ...stored.tasks[1], key: 'supplementary-link-repair-v1', toVersion: '0.7.0' }];
    db.upgradePlan.findFirst.mockResolvedValue(stored);
    db.upgradePlan.create.mockResolvedValueOnce({ id: 18 });
    db.appSetting.findUnique.mockResolvedValue({ value: '0.1.0' });
    db.mailLog.findMany.mockResolvedValue([{ accountId: 1, uid: 10, parserId: 'icbc2026' }]);
    db.upgradeTask.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (
      where.key === approved.key ? approved : null
    ));
    supplementaryLinks(null);

    await initializeUpgradeState(true);

    const carried = db.upgradeTask.update.mock.calls.find(([args]) => args.where.id === approved.id);
    expect(carried?.[0].data).toEqual(expect.objectContaining({ key: approved.key, planId: 18 }));
    expect(carried?.[0].data).not.toHaveProperty('status');
    expect(carried?.[0].data).not.toHaveProperty('approvedAt');
  });

  it('已保存计划读取最新展示文案，保留旧快照和任务状态且不写库', async () => {
    const stored = storedPlan();
    db.upgradePlan.findFirst.mockResolvedValue(stored);
    db.upgradePlan.findUnique.mockResolvedValue(stored);
    const result = await getUpgradePlan();
    expect(result?.migrations[1].title).toBe(accountZeroBillsMigration.title);
    expect(result?.migrations[0].summary).toBe('工商银行 · 共 4 封已识别的历史账单邮件');
    expect(result?.migrations[1].summary).toBe('平安银行 · 共 4 张卡的本期账单');
    expect(result?.tasks[1]).toEqual(expect.objectContaining({
      title: accountZeroBillsMigration.title, description: accountZeroBillsMigration.description,
      ignoreLabel: '忽略更新', status: 'awaiting_decision', total: 4, processed: 1, succeeded: 1,
      ignoreWarning: accountZeroBillsMigration.ignoreWarning,
    }));
    expect(stored.tasks[1].title).toBe('旧工程标题');
    expect(stored.manifest[1].title).toBe('旧工程标题');
    expect(db.upgradeTask.update).not.toHaveBeenCalled();
    expect(db.upgradePlan.update).not.toHaveBeenCalled();
    expect(db.mailLog.findMany).not.toHaveBeenCalled();
  });

  it('0.5.0 已完成后升级程序不再盘点历史修复，也不创建重复迁移', async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: '0.5.0' });
    expect((await initializeUpgradeState(true)).runtimeMode).toBe('ready');
    expect(repairStatements050Migration.targetVersion).toBe('0.5.0');
    expect(repairStatements050Migration.mode).toBe('optional');
    expect(db.mailLog.findMany).not.toHaveBeenCalled();
    expect(db.upgradePlan.create).not.toHaveBeenCalled();
    expect(db.upgradeTask.create).not.toHaveBeenCalled();
  });

  it('notice 迁移入盘时创建不阻碍业务的提醒任务', async () => {
    noticeState.enabled = true;
    db.appSetting.findUnique.mockResolvedValue({ value: '0.5.1' });
    db.upgradeTask.create.mockResolvedValue({ id: 21 });

    const result = await initializeUpgradeState(true);

    expect(result.runtimeMode).toBe('optional_wait');
    expect(isUpgradeBusinessBlocked()).toBe(false);
    expect(db.upgradeTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'overdue-basis-notice-v1',
        mode: 'notice',
        status: 'awaiting_decision',
      }),
    });
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('已生成的 0.5 必选历史修复计划改回可选，保留执行窗口与用户决定', async () => {
    const stored = storedPlan();
    stored.hasRequired = true;
    stored.tasks = [{ ...stored.tasks[0], key: repairStatements050Migration.key, toVersion: '0.5.0', mode: 'required' }];
    stored.manifest = stored.tasks.map(task => ({ ...task, targetVersion: task.toVersion, order: task.migrationOrder, summary: null }));
    db.appSetting.findUnique.mockResolvedValue({ value: '0.4.2' });
    db.upgradePlan.findFirst.mockResolvedValue(stored);
    expect((await initializeUpgradeState(true)).runtimeMode).toBe('optional_wait');
    expect(isUpgradeBusinessBlocked()).toBe(false);
    expect(db.upgradeTask.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { mode: 'optional', ignoreLabel: '忽略更新' } });
    expect(db.upgradePlan.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ hasRequired: false }) }));
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
    expect(db.mailLog.findMany).not.toHaveBeenCalled();
  });

  it('重启恢复邮箱失败状态时业务仍可用，仅列出明确失败的邮箱且不返回授权码', async () => {
    const stored = storedPlan();
    stored.status = 'failed';
    stored.tasks[0].status = 'failed';
    db.upgradePlan.findFirst.mockResolvedValue(stored);
    db.upgradePlan.findUnique.mockResolvedValue(stored);
    db.upgradeTaskItem.findMany.mockResolvedValue([
      { payload: { accountId: 1, failureKind: 'mailbox_unavailable' } },
      { payload: { accountId: 1, failureKind: 'mailbox_unavailable' } },
      { payload: { accountId: 2, failureKind: 'mailbox_unavailable' } },
      { payload: { accountId: 3 } },
    ]);
    db.emailAccount.findMany.mockResolvedValue([{ id: 1, email: 'one@example.test' }, { id: 2, email: 'two@example.test' }]);
    expect((await initializeUpgradeState(true)).runtimeMode).toBe('failed');
    expect(isUpgradeBusinessBlocked()).toBe(false);
    expect((await getUpgradePlan())?.mailboxFailures).toHaveLength(2);
    expect(db.emailAccount.findMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } }, orderBy: { id: 'asc' },
      select: { id: true, email: true, imapHost: true, imapPort: true, tls: true, authUser: true } });
  });

  it('一次保存所有选择后才启动整个计划', async () => {
    const stored = storedPlan();
    db.appSetting.findUnique.mockResolvedValue({ value: '0.1.0' });
    db.upgradePlan.findUnique.mockResolvedValue(stored);
    await submitUpgradeDecisions(8, [
      { key: stored.tasks[0].key, action: 'ignore' }, { key: stored.tasks[1].key, action: 'approve' },
    ]);
    expect(db.upgradeTask.update).toHaveBeenCalledTimes(2);
    expect(db.upgradeTask.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: 'ignored' }) }));
    expect(db.upgradeTask.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) }));
    expect(db.upgradePlan.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'executing' }) }));
    expect(db.upgradePlan.update.mock.invocationCallOrder[0]).toBeGreaterThan(db.upgradeTask.update.mock.invocationCallOrder[1]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('后项是不可忽略的必选项目时，前项也不能部分保存', async () => {
    const stored = storedPlan();
    stored.tasks[1].mode = 'required';
    db.appSetting.findUnique.mockResolvedValue({ value: '0.1.0' });
    db.upgradePlan.findUnique.mockResolvedValue(stored);
    await expect(submitUpgradeDecisions(8, stored.tasks.map((task) => ({ key: task.key, action: 'ignore' })))).rejects.toThrow('不能忽略');
    expect(db.upgradeTask.update).not.toHaveBeenCalled();
    expect(db.upgradePlan.update).not.toHaveBeenCalled();
  });

  it.each(['missing', 'duplicate', 'extra', 'past_cursor', 'already_executing', 'already_ignored'])('拒绝失效或不完整的整批选择：%s', async (scenario) => {
    const stored = storedPlan();
    let decisions: Array<{ key: string; action: 'approve' }> = stored.tasks.map((task) => ({ key: task.key, action: 'approve' }));
    if (scenario === 'missing') decisions.pop();
    if (scenario === 'duplicate') decisions = [decisions[0], decisions[0]];
    if (scenario === 'extra') decisions.push({ key: 'unknown', action: 'approve' });
    if (scenario === 'already_executing') stored.status = 'executing';
    if (scenario === 'already_ignored') stored.tasks[1].status = 'ignored';
    db.appSetting.findUnique.mockResolvedValue({ value: scenario === 'past_cursor' ? APP_VERSION : '0.1.0' });
    db.upgradePlan.findUnique.mockResolvedValue(stored);
    await expect(submitUpgradeDecisions(8, decisions)).rejects.toThrow();
    expect(db.upgradeTask.update).not.toHaveBeenCalled();
    expect(db.upgradePlan.update).not.toHaveBeenCalled();
  });
});
