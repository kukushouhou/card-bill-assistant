import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supplementaryLinkRepairMigration } from '../src/modules/upgrades/migrations/supplementary-link-repair';

// mock db 结构对齐扫描所需子集，调用处以 as never 满足 PrismaClient 形参
const inspect = supplementaryLinkRepairMigration.inspect;
const executeTask = supplementaryLinkRepairMigration.executeTask!;

// mock prisma：inspect 用传入的 db；prepareTask/executeTask 用模块内 prisma
const db = vi.hoisted(() => ({
  card: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bill: { findMany: vi.fn() },
  billCard: { findMany: vi.fn() },
  upgradeTaskItem: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  upgradeTask: { update: vi.fn() },
  $transaction: vi.fn(),
}));
const tx = vi.hoisted(() => ({
  card: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));

const orphanCard = {
  id: 445,
  bankName: '广发银行',
  displayLast4: '6736',
};
const primaryCard = {
  id: 444,
  bankName: '广发银行',
  cardLast4: '1119',
  statementDay: 26,
  dueRule: 'offset',
  dueDay: null,
  dueOffsetDays: 20,
};

/** 证据账单：bill.cardId 为承接卡，BillCard 把孤卡与承接卡挂同一封 */
function evidenceBills() {
  return [
    { id: 101, cardId: 444, period: '2026-08', statementDate: new Date('2026-08-25T00:00:00+08:00') },
    { id: 100, cardId: 444, period: '2026-07', statementDate: new Date('2026-07-25T00:00:00+08:00') },
  ];
}

function setupScanMocks({
  orphans = [orphanCard],
  owners = [primaryCard],
  links = [{ billId: 101, cardId: 445 }, { billId: 100, cardId: 445 }],
  bills = evidenceBills(),
} = {}) {
  db.card.findMany.mockImplementation(async (args: { where?: Record<string, unknown> } = {}) => {
    const where = args.where ?? {};
    if (where.businessRole === 'supplementary') return orphans;
    if (where.id != null) return owners;
    return [];
  });
  db.billCard.findMany.mockResolvedValue(links);
  db.bill.findMany.mockResolvedValue(bills);
}

describe('supplementary-link-repair 可选迁移', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.card.findMany.mockResolvedValue([]);
    db.bill.findMany.mockResolvedValue([]);
    db.billCard.findMany.mockResolvedValue([]);
    db.upgradeTaskItem.findMany.mockResolvedValue([]);
    db.upgradeTaskItem.count.mockResolvedValue(0);
    db.upgradeTaskItem.groupBy.mockResolvedValue([]);
    db.upgradeTaskItem.createMany.mockResolvedValue({ count: 1 });
    db.upgradeTaskItem.update.mockResolvedValue({});
    db.upgradeTask.update.mockResolvedValue({});
    db.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
    tx.card.findUnique.mockResolvedValue(primaryCard);
    tx.card.update.mockResolvedValue({});
  });

  it('定义与可选迁移边界一致', () => {
    expect(supplementaryLinkRepairMigration.key).toBe('supplementary-link-repair-v1');
    expect(supplementaryLinkRepairMigration.targetVersion).toBe('0.7.0');
    expect(supplementaryLinkRepairMigration.mode).toBe('optional');
    expect(supplementaryLinkRepairMigration.executeLabel).toBe('现在执行');
    expect(supplementaryLinkRepairMigration.ignoreWarning).toContain('不再提供');
  });

  it('无空关联附属卡时不进入升级计划', async () => {
    expect(await inspect(db as never)).toBeNull();
  });

  it('有同银行证据账单的空关联附属卡进入盘点', async () => {
    setupScanMocks();
    const inspection = await inspect(db as never);
    expect(inspection?.total).toBe(1);
    expect(inspection?.summary).toContain('广发银行');
  });

  it('自己承接的账单不作证据', async () => {
    setupScanMocks({
      links: [{ billId: 102, cardId: 445 }],
      bills: [{ id: 102, cardId: 445, period: '2026-08', statementDate: new Date('2026-08-25T00:00:00+08:00') }],
      owners: [],
    });
    expect(await inspect(db as never)).toBeNull();
  });

  it('承接卡隐藏或跨银行时不作证据', async () => {
    setupScanMocks({
      owners: [{ ...primaryCard, id: 999, bankName: '招商银行' }],
      links: [{ billId: 103, cardId: 445 }],
      bills: [{ id: 103, cardId: 999, period: '2026-08', statementDate: new Date('2026-08-25T00:00:00+08:00') }],
    });
    expect(await inspect(db as never)).toBeNull();
  });

  it('executeTask 按最新证据账单挂回承接卡并对齐规则', async () => {
    setupScanMocks();
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where && 'status' in where) {
        return [{
          id: 1,
          taskId: 5,
          itemKey: 'card:445',
          payload: {
            cardId: 445,
            bankName: '广发银行',
            cardLast4: '6736',
            primaryCardId: 444,
            primaryCardLast4: '1119',
            period: '2026-08',
            statementDate: new Date('2026-08-25T00:00:00+08:00').toISOString(),
          },
          status: 'pending',
        }];
      }
      return [];
    });
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'succeeded', _count: 1 }]);

    const result = await executeTask(5);

    expect(result.succeeded).toBe(1);
    expect(tx.card.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 444 },
    }));
    expect(tx.card.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 445 },
      data: expect.objectContaining({
        businessRole: 'supplementary',
        businessPrimaryId: 444,
        businessRelationDate: new Date('2026-08-25T00:00:00+08:00'),
        statementDay: 26,
        dueRule: 'offset',
        dueDay: null,
        dueOffsetDays: 20,
      }),
    }));
  });

  it('目标消失（关联已被合账建立）时记 unchanged', async () => {
    setupScanMocks({ orphans: [] });
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where && 'status' in where) {
        return [{
          id: 2,
          taskId: 5,
          itemKey: 'card:445',
          payload: {
            cardId: 445,
            bankName: '广发银行',
            cardLast4: '6736',
            primaryCardId: 444,
            primaryCardLast4: '1119',
            period: '2026-08',
            statementDate: new Date('2026-08-25T00:00:00+08:00').toISOString(),
          },
          status: 'pending',
        }];
      }
      return [];
    });
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'unchanged', _count: 1 }]);

    const result = await executeTask(5);

    expect(result.succeeded).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(tx.card.update).not.toHaveBeenCalled();
  });

  it('承接卡执行时已隐藏则记 failed 不静默放过', async () => {
    setupScanMocks();
    tx.card.findUnique.mockResolvedValue({ ...primaryCard, hidden: true });
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where && 'status' in where) {
        return [{
          id: 3,
          taskId: 5,
          itemKey: 'card:445',
          payload: {
            cardId: 445,
            bankName: '广发银行',
            cardLast4: '6736',
            primaryCardId: 444,
            primaryCardLast4: '1119',
            period: '2026-08',
            statementDate: new Date('2026-08-25T00:00:00+08:00').toISOString(),
          },
          status: 'pending',
        }];
      }
      return [];
    });
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'failed', _count: 1 }]);

    const result = await executeTask(5);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.error).toContain('失败');
    expect(tx.card.update).not.toHaveBeenCalled();
  });
});
