import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  emailAccount: { count: vi.fn(), findMany: vi.fn() },
  mailLog: { findMany: vi.fn(), findUnique: vi.fn() },
  card: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
import { getUpgradePlan, initializeUpgradeState, submitUpgradeDecisions } from '../src/modules/upgrades/upgrade.service';
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
