import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supplementaryLinkRepairMigration } from '../src/modules/upgrades/migrations/supplementary-link-repair';

// mock db 结构对齐扫描所需子集，调用处以 as never 满足 PrismaClient 形参
const inspect = supplementaryLinkRepairMigration.inspect;
const prepareTask = supplementaryLinkRepairMigration.prepareTask!;
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
  card: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bill: { findMany: vi.fn() },
  billCard: { findMany: vi.fn() },
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
  dueDay: null as number | null,
  dueOffsetDays: 20 as number | null,
  hidden: false,
  businessRole: 'primary',
  businessPrimaryId: null as number | null,
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
    if (where.businessRole === 'supplementary') return orphans.filter((card) => where.id == null || card.id === where.id);
    if (where.id != null) return owners.filter((card) => !card.hidden
      && (!where.NOT || card.businessRole !== 'supplementary' || card.businessPrimaryId != null));
    return [];
  });
  db.billCard.findMany.mockResolvedValue(links);
  db.bill.findMany.mockResolvedValue(bills);
}

/** 保留真实任务快照，状态与计数随执行结果变化，避免预设成功掩盖写入错误。 */
function setupStoredTaskItem(payload: unknown, status = 'pending') {
  const item = { id: 4, taskId: 5, itemKey: 'card:445', payload, status, error: null as string | null };
  db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: {
    where: { status?: { in: string[] } };
  }) => where.status && !where.status.in.includes(item.status) ? [] : [{ ...item }]);
  db.upgradeTaskItem.update.mockImplementation(async ({ data }: { data: Partial<typeof item> }) => {
    Object.assign(item, data);
    return { ...item };
  });
  db.upgradeTaskItem.count.mockResolvedValue(1);
  db.upgradeTaskItem.groupBy.mockImplementation(async () => [{ status: item.status, _count: 1 }]);
  return item;
}

async function prepareStoredTaskItem() {
  setupScanMocks();
  await prepareTask(5);
  return setupStoredTaskItem(db.upgradeTaskItem.createMany.mock.calls[0][0].data[0].payload);
}

function orphanState() {
  return {
    ...orphanCard,
    businessRole: 'supplementary',
    businessPrimaryId: null as number | null,
    businessRelationDate: null as Date | null,
    hidden: false,
    statementDay: 1,
    dueRule: 'fixed',
    dueDay: 2 as number | null,
    dueOffsetDays: null as number | null,
  };
}

/** 模拟数据库按条件更新；保留无条件 update，以检测是否会覆盖并发写入。 */
function setupCardWrites(card: ReturnType<typeof orphanState>) {
  tx.card.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(card, data);
    return { ...card };
  });
  tx.card.updateMany.mockImplementation(async ({ where, data }: {
    where: Record<string, unknown> & { OR?: Array<{ businessRelationDate: null | { lte: Date } }> };
    data: Record<string, unknown>;
  }) => {
    const { OR, ...fields } = where;
    const matchesFields = Object.entries(fields).every(([key, value]) => (
      (card as unknown as Record<string, unknown>)[key] === value
    ));
    const matchesDate = !OR || OR.some(({ businessRelationDate: date }) => date === null
      ? card.businessRelationDate === null
      : card.businessRelationDate != null && card.businessRelationDate.getTime() <= date.lte.getTime());
    if (!matchesFields || !matchesDate) return { count: 0 };
    Object.assign(card, data);
    return { count: 1 };
  });
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
    tx.card.findMany.mockImplementation((args: unknown) => db.card.findMany(args));
    tx.bill.findMany.mockImplementation((args: unknown) => db.bill.findMany(args));
    tx.billCard.findMany.mockImplementation((args: unknown) => db.billCard.findMany(args));
    tx.card.findUnique.mockResolvedValue(primaryCard);
    tx.card.update.mockResolvedValue({});
    tx.card.updateMany.mockResolvedValue({ count: 1 });
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
    expect(tx.card.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 445 }),
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

  it.each([
    { name: '最新账单改为另一张主卡', owner: { ...primaryCard, id: 446, cardLast4: '2222', statementDay: 18, dueRule: 'fixed', dueDay: 8, dueOffsetDays: null } },
    { name: '主卡不变但证据账单已更新', owner: primaryCard },
  ])('任务准备后$name，执行使用最新目标和关系日期', async ({ owner }) => {
    setupScanMocks();
    await prepareTask(5);
    const payload = db.upgradeTaskItem.createMany.mock.calls[0][0].data[0].payload;
    const item = setupStoredTaskItem(payload);
    expect(payload.primaryCardId).toBe(444);
    expect(payload.period).toBe('2026-08');

    const statementDate = new Date('2026-09-25T00:00:00+08:00');
    setupScanMocks({
      owners: [primaryCard, owner],
      links: [{ billId: 102, cardId: 445 }, { billId: 101, cardId: 445 }, { billId: 100, cardId: 445 }],
      bills: [...evidenceBills(), { id: 102, cardId: owner.id, period: '2026-09', statementDate }],
    });
    tx.card.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => (
      where.id === owner.id ? owner : primaryCard
    ));

    const result = await executeTask(5);

    expect(result).toEqual({ succeeded: 1, unchanged: 0, failed: 0, error: undefined });
    expect(item.status).toBe('succeeded');
    expect(item.payload).toEqual(payload);
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledTimes(1);
    expect(tx.card.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: owner.id } }));
    const writes = [...tx.card.update.mock.calls, ...tx.card.updateMany.mock.calls];
    expect(writes).toEqual([[expect.objectContaining({
      where: expect.objectContaining({ id: 445 }),
      data: {
        businessRole: 'supplementary',
        businessPrimaryId: owner.id,
        businessRelationDate: statementDate,
        statementDay: owner.statementDay,
        dueRule: owner.dueRule,
        dueDay: owner.dueDay,
        dueOffsetDays: owner.dueOffsetDays,
      },
    })]]);
  });

  it('进入逐卡事务前后台账单证据再次变化，事务内重新选择最新目标', async () => {
    await prepareStoredTaskItem();
    const owner = { ...primaryCard, id: 446, cardLast4: '2222' };
    const statementDate = new Date('2026-09-25T00:00:00+08:00');
    db.$transaction.mockImplementationOnce(async (fn: (t: typeof tx) => unknown) => {
      setupScanMocks({
        owners: [primaryCard, owner],
        links: [{ billId: 102, cardId: 445 }],
        bills: [{ id: 102, cardId: owner.id, period: '2026-09', statementDate }],
      });
      tx.card.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => (
        where.id === owner.id ? owner : primaryCard
      ));
      return fn(tx);
    });

    expect(await executeTask(5)).toEqual({ succeeded: 1, unchanged: 0, failed: 0, error: undefined });
    expect(tx.card.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ businessPrimaryId: owner.id, businessRelationDate: statementDate }),
    }));
    expect(tx.card.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 445, businessRole: 'supplementary', businessPrimaryId: null, hidden: false },
    }));
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('逐卡重扫保留原扫描口径，不把其他空关联附属卡当作承接卡', async () => {
    await prepareStoredTaskItem();
    const otherOrphan = { ...orphanCard, id: 447, displayLast4: '3333' };
    setupScanMocks({
      orphans: [orphanCard, otherOrphan],
      owners: [primaryCard, { ...primaryCard, id: 447, cardLast4: '3333', businessRole: 'supplementary' }],
      links: [{ billId: 102, cardId: 445 }, { billId: 101, cardId: 445 }],
      bills: [...evidenceBills(), {
        id: 102, cardId: 447, period: '2026-09', statementDate: new Date('2026-09-25T00:00:00+08:00'),
      }],
    });

    expect((await executeTask(5)).succeeded).toBe(1);
    expect(tx.card.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessPrimaryId: primaryCard.id, businessRelationDate: evidenceBills()[0].statementDate,
      }),
    }));
  });

  it('事务并发冲突保留失败状态，重试仍可恢复关联', async () => {
    const item = await prepareStoredTaskItem();
    db.$transaction.mockRejectedValueOnce(new Error('事务写入冲突'));

    expect((await executeTask(5)).failed).toBe(1);
    expect(item.status).toBe('failed');
    expect(item.error).toBe('事务写入冲突');
    expect(tx.card.updateMany).not.toHaveBeenCalled();

    expect(await executeTask(5)).toEqual({ succeeded: 1, unchanged: 0, failed: 0, error: undefined });
    expect(item.status).toBe('succeeded');
    expect(item.error).toBeNull();
    expect(tx.card.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: '已建立新的主卡关联', patch: { businessPrimaryId: 999 } },
    { name: '卡片已隐藏', patch: { hidden: true } },
    { name: '卡片已改为普通卡', patch: { businessRole: 'standalone' } },
    { name: '已有比证据账单更新的关系日期', patch: { businessRelationDate: new Date('2026-09-25T00:00:00+08:00') } },
  ])('扫描后$name，不覆盖卡片及其账期规则', async ({ patch }) => {
    const item = await prepareStoredTaskItem();
    const card = orphanState();
    setupCardWrites(card);
    const expected = { ...card, ...patch };
    // 扫描已经完成，读取承接卡时另一业务写入改变了附属卡。
    tx.card.findUnique.mockImplementationOnce(async () => {
      Object.assign(card, patch);
      return primaryCard;
    });

    expect(await executeTask(5)).toEqual({ succeeded: 0, unchanged: 1, failed: 0, error: undefined });
    expect(card).toEqual(expected);
    expect(item.status).toBe('unchanged');
    expect(tx.card.update).not.toHaveBeenCalled();
  });

  it('成功后重复执行不再次修改关联或规则，也不重复创建明细', async () => {
    const item = await prepareStoredTaskItem();
    const card = orphanState();
    setupCardWrites(card);
    const first = await executeTask(5);
    expect(first.succeeded).toBe(1);
    expect(card.businessPrimaryId).toBe(primaryCard.id);
    expect(item.status).toBe('succeeded');
    // 重复调用期间用户又调整了规则，已成功明细不得重写。
    card.statementDay = 9;
    const expected = { ...card };

    expect(await executeTask(5)).toEqual(first);
    expect(card).toEqual(expected);
    expect(tx.card.updateMany).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('失败重试重新选择最新主卡，使用承接卡当前规则', async () => {
    const item = await prepareStoredTaskItem();
    tx.card.findUnique.mockResolvedValueOnce({ ...primaryCard, hidden: true });
    expect(await executeTask(5)).toEqual({
      succeeded: 0, unchanged: 0, failed: 1, error: '部分附属卡关联恢复失败，请重试',
    });
    expect(item.status).toBe('failed');
    expect(tx.card.updateMany).not.toHaveBeenCalled();

    const owner = { ...primaryCard, id: 446, cardLast4: '2222' };
    const statementDate = new Date('2026-09-25T00:00:00+08:00');
    setupScanMocks({
      owners: [primaryCard, owner],
      links: [{ billId: 102, cardId: 445 }],
      bills: [{ id: 102, cardId: owner.id, period: '2026-09', statementDate }],
    });
    tx.card.findUnique.mockResolvedValue({ ...owner, statementDay: 7, dueOffsetDays: 25 });

    expect(await executeTask(5)).toEqual({ succeeded: 1, unchanged: 0, failed: 0, error: undefined });
    expect(item.status).toBe('succeeded');
    expect(item.error).toBeNull();
    expect(tx.card.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessPrimaryId: owner.id, businessRelationDate: statementDate, statementDay: 7, dueOffsetDays: 25,
      }),
    }));
  });

  it('关联提交成功但明细状态保存失败时，重试不覆盖已恢复关系', async () => {
    const item = await prepareStoredTaskItem();
    const card = orphanState();
    setupCardWrites(card);
    const saveItem = db.upgradeTaskItem.update.getMockImplementation()!;
    db.upgradeTaskItem.update.mockImplementation(async (args: { data: { status?: string } }) => {
      if (args.data.status === 'succeeded') throw new Error('状态写入暂时失败');
      return saveItem(args);
    });

    expect((await executeTask(5)).failed).toBe(1);
    expect(card.businessPrimaryId).toBe(primaryCard.id);
    expect(item.status).toBe('failed');
    card.statementDay = 9;
    const expected = { ...card };
    setupScanMocks({ orphans: [] });

    expect(await executeTask(5)).toEqual({ succeeded: 0, unchanged: 1, failed: 0, error: undefined });
    expect(card).toEqual(expected);
    expect(item.status).toBe('unchanged');
    expect(item.error).toBeNull();
    expect(tx.card.updateMany).toHaveBeenCalledTimes(1);
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
    expect(tx.card.updateMany).not.toHaveBeenCalled();
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
    expect(tx.card.updateMany).not.toHaveBeenCalled();
  });
});
