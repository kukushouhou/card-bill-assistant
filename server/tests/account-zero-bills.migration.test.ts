import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountZeroBillsMigration } from '../src/modules/upgrades/migrations/backfill-account-zero-bills';
import { accountZeroBillsMigrationV2 } from '../src/modules/upgrades/migrations/backfill-account-zero-bills-v2';

// mock db 结构对齐扫描所需子集，调用处以 as never 满足 PrismaClient 形参
const inspect = accountZeroBillsMigration.inspect;
const executeTask = accountZeroBillsMigration.executeTask!;

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
  card: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  bill: { upsert: vi.fn(), findMany: vi.fn() },
  billCard: { findMany: vi.fn() },
}));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));

function currentBillDates() {
  const statement = new Date();
  statement.setDate(statement.getDate() - 1);
  statement.setHours(0, 0, 0, 0);
  const due = new Date(statement);
  due.setDate(due.getDate() + 18);
  const period = `${statement.getFullYear()}-${String(statement.getMonth() + 1).padStart(2, '0')}`;
  return { statement, due, period };
}

function householdCards(statementDay = 5) {
  return [
    { id: 7, bankName: '招商银行', cardLast4: '1234', displayLast4: '1234', holderName: '张三', status: 'active', businessRole: 'standalone', businessPrimaryId: null, statementDay, dueRule: 'offset', dueDay: null, dueOffsetDays: 18 },
    { id: 8, bankName: '招商银行', cardLast4: '5678', displayLast4: '5678', holderName: '张三', status: 'active', businessRole: 'standalone', businessPrimaryId: null, statementDay, dueRule: 'offset', dueDay: null, dueOffsetDays: 18 },
  ];
}

function householdBills(period: string, statement: Date, due: Date) {
  return [
    {
      id: 1,
      cardId: 7,
      period,
      statementDate: statement,
      dueDate: due,
      currency: 'CNY',
      card: { bankName: '招商银行', holderName: '张三', businessRole: 'standalone', businessPrimaryId: null },
    },
  ];
}

describe('account-zero-bills 可选迁移', () => {
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
    tx.card.findMany.mockResolvedValue([]);
    tx.bill.findMany.mockResolvedValue([]);
    tx.billCard.findMany.mockResolvedValue([]);
    tx.bill.upsert.mockResolvedValue({ id: 900 });
  });

  it('无户级银行数据时不进入升级计划', async () => {
    expect(await inspect(db as never)).toBeNull();
  });

  it('当前待还账期同户无账单卡进入盘点并同步规则口径', async () => {
    const { statement, due, period } = currentBillDates();
    // 卡 8 规则陈旧（10 号出账），同步到最新账单规则后落入当前待还窗口
    db.card.findMany.mockResolvedValue(householdCards(10));
    db.bill.findMany.mockResolvedValue(householdBills(period, statement, due));

    const inspection = await inspect(db as never);
    expect(inspection?.total).toBe(1);
    expect(inspection?.summary).toContain('招商银行');
  });

  it('期次已滚走（最新账单非当前期）的卡不进入盘点', async () => {
    const statement = new Date();
    statement.setMonth(statement.getMonth() - 3);
    statement.setHours(0, 0, 0, 0);
    const due = new Date(statement);
    due.setDate(due.getDate() + 18);
    const period = `${statement.getFullYear()}-${String(statement.getMonth() + 1).padStart(2, '0')}`;
    db.card.findMany.mockResolvedValue(householdCards());
    db.bill.findMany.mockResolvedValue(householdBills(period, statement, due));

    expect(await inspect(db as never)).toBeNull();
  });

  it('executeTask 为目标卡落零账单并传播户内规则', async () => {
    const { statement, due, period } = currentBillDates();
    db.card.findMany.mockResolvedValue(householdCards());
    db.bill.findMany.mockResolvedValue(householdBills(period, statement, due));
    // prepareTask：无历史条目；executeTask：待处理条目按 where.status 区分
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where && 'status' in where) {
        return [{
          id: 1,
          taskId: 5,
          itemKey: `card:8:${period}:CNY`,
          payload: {
            cardId: 8,
            bankName: '招商银行',
            cardLast4: '5678',
            holderName: '张三',
            period,
            statementDate: statement.toISOString(),
            dueDate: due.toISOString(),
            currency: 'CNY',
          },
          status: 'pending',
        }];
      }
      return [];
    });
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'succeeded', _count: 1 }]);
    // tx 内：卡 7 已有本期真实账单（自有），只有卡 8 需要补零账单
    tx.card.findMany.mockResolvedValue(householdCards().map((card) => ({ ...card, statementDay: 10 })));
    tx.bill.findMany.mockResolvedValue([{ cardId: 7 }]);

    const result = await executeTask(5);

    expect(result.succeeded).toBe(1);
    expect(tx.bill.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { cardId_period_currency: expect.objectContaining({ cardId: 8, period, currency: 'CNY' }) },
      create: expect.objectContaining({ source: 'auto-none', paidStatus: 'paid', amount: 0, mailLogId: null }),
      update: {},
    }));
    expect(tx.bill.upsert).toHaveBeenCalledTimes(1);
    // 规则传播到全户（含账单承接卡）
    expect(tx.card.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [7, 8] } },
    }));
  });

  it('目标消失（真实账单已到或期次滚走）时记 unchanged', async () => {
    const { statement, due, period } = currentBillDates();
    db.card.findMany.mockResolvedValue(householdCards());
    db.bill.findMany.mockResolvedValue(householdBills(period, statement, due));
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where && 'status' in where) {
        return [{
          id: 2,
          taskId: 5,
          itemKey: 'card:99:2099-01:CNY',
          payload: { cardId: 99, bankName: '招商银行', cardLast4: '9999', holderName: '张三', period: '2099-01', statementDate: statement.toISOString(), dueDate: due.toISOString(), currency: 'CNY' },
          status: 'pending',
        }];
      }
      return [];
    });
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'unchanged', _count: 1 }]);

    const result = await executeTask(5);

    expect(result.succeeded).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(db.upgradeTaskItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 2 },
      data: expect.objectContaining({ status: 'unchanged' }),
    }));
    expect(tx.bill.upsert).not.toHaveBeenCalled();
  });
});

describe('account-zero-bills v2 可选迁移（0.5.2 锚点）', () => {
  it('定义与新银行扩容语义一致', () => {
    expect(accountZeroBillsMigrationV2.key).toBe('account-zero-bills-current-v2');
    expect(accountZeroBillsMigrationV2.targetVersion).toBe('0.5.2');
    expect(accountZeroBillsMigrationV2.mode).toBe('optional');
    expect(accountZeroBillsMigrationV2.ignoreLabel).toBe('忽略更新');
    expect(accountZeroBillsMigrationV2.ignoreWarning).toContain('不再提供');
    // 盘点与执行复用 v1 的动态扫描与落库口径
    expect(accountZeroBillsMigrationV2.inspect).toBe(accountZeroBillsMigration.inspect);
    expect(accountZeroBillsMigrationV2.prepareTask).toBe(accountZeroBillsMigration.prepareTask);
    expect(accountZeroBillsMigrationV2.executeTask).toBe(accountZeroBillsMigration.executeTask);
  });

  it('describeImpact 只列盘点出的实际银行', () => {
    const impact = accountZeroBillsMigrationV2.describeImpact!({
      total: 3,
      payload: { banks: ['浦发银行', '北京银行', '浦发银行'] },
    });
    expect(impact).toBe('北京银行、浦发银行 · 共 3 张卡的本期账单');

    expect(accountZeroBillsMigrationV2.describeImpact!({ total: 0, payload: {} })).toBeNull();
    expect(accountZeroBillsMigrationV2.describeImpact!({ total: 0, payload: { banks: [] } })).toBeNull();
  });
});
