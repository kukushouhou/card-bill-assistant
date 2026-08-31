import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  emailAccount: { count: vi.fn() },
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
const schedulerMocks = vi.hoisted(() => ({ pause: vi.fn(), start: vi.fn() }));

vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/parsers/registry', () => ({
  listBusinessRelationshipParsers: parserMocks.list,
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
  pauseScheduler: schedulerMocks.pause,
  startScheduler: schedulerMocks.start,
}));

import { APP_VERSION } from '../src/version';
import { initializeUpgradeState } from '../src/modules/upgrades/upgrade.service';

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
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    db.appSetting.findUnique.mockResolvedValue({ value: APP_VERSION });
    db.emailAccount.count.mockResolvedValue(0);
    db.upgradePlan.findFirst.mockResolvedValue(null);
    db.upgradeTask.findMany.mockResolvedValue([]);
    db.upgradeTask.findUnique.mockResolvedValue(null);
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
    expect(result).toEqual({ runtimeMode: 'ready', shouldStartScheduler: true, shouldResumeExecution: false });
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
  });
});
