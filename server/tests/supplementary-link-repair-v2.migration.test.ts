import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supplementaryLinkRepairMigrationV2 as migration } from '../src/modules/upgrades/migrations/supplementary-link-repair-v2';

const db = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  bill: { findMany: vi.fn() },
  billCard: { findMany: vi.fn() },
  upgradeTaskItem: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), update: vi.fn() },
  upgradeTask: { update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/lib/card-groups', () => ({ recomputePrimary: vi.fn() }));

const august = new Date('2026-08-25T00:00:00+08:00');
const september = new Date('2026-09-25T00:00:00+08:00');
const processedAt = new Date('2026-10-18T10:00:00+08:00');
const oldPayload = {
  cardId: 445, bankName: '广发银行', cardLast4: '6736', primaryCardId: 444,
  primaryCardLast4: '1119', period: '2026-08', statementDate: august.toISOString(),
};

function card(id: number, primaryId: number | null = null) {
  return {
    id, bankName: '广发银行', displayLast4: String(id), cardLast4: String(id),
    businessRole: id === 445 ? 'supplementary' : 'primary', businessPrimaryId: primaryId,
    businessRelationDate: id === 445 ? august : null as Date | null,
    hidden: false, statementDay: 26, dueRule: 'offset', dueDay: null as number | null, dueOffsetDays: 20 as number | null,
  };
}
type TaskItem = {
  id: number; taskId: number; itemKey: string; payload: unknown; status: string;
  processedAt: Date | null; error: string | null;
};
let cards: ReturnType<typeof card>[];
let bills: Array<{ id: number; cardId: number; period: string; statementDate: Date; updatedAt: Date }>;
let links: Array<{ billId: number; cardId: number }>;
let history: TaskItem[];
let items: TaskItem[];

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Record<string, unknown>[]).some((part) => matches(row, part));
    if (key === 'NOT') return !matches(row, value as Record<string, unknown>);
    if (value instanceof Date) return row[key] instanceof Date && (row[key] as Date).getTime() === value.getTime();
    if (value && typeof value === 'object') {
      const condition = value as { in?: unknown[]; not?: unknown; lte?: Date };
      if (condition.in) return condition.in.includes(row[key]);
      if ('not' in condition) return row[key] !== condition.not;
      if (condition.lte) return row[key] instanceof Date && (row[key] as Date) <= condition.lte;
    }
    return row[key] === value;
  });
}

describe('0.7.1 附属卡可选纠错迁移', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cards = [card(444), card(445, 444), { ...card(446), statementDay: 18, dueOffsetDays: 25 }];
    bills = [
      { id: 101, cardId: 444, period: '2026-08', statementDate: august, updatedAt: august },
      { id: 102, cardId: 446, period: '2026-09', statementDate: september, updatedAt: september },
    ];
    links = [{ billId: 101, cardId: 445 }, { billId: 102, cardId: 445 }];
    history = [{ id: 1, taskId: 1, itemKey: 'card:445', payload: oldPayload, status: 'succeeded', processedAt, error: null }];
    items = [];
    db.card.findMany.mockImplementation(async ({ where = {} }: { where?: Record<string, unknown> }) => (
      cards.filter((row) => matches(row, where)).map((row) => ({ ...row }))
    ));
    db.card.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) => (
      cards.find((row) => row.id === where.id) ?? null
    ));
    db.card.updateMany.mockImplementation(async ({ where, data }: {
      where: Record<string, unknown>; data: Record<string, unknown>;
    }) => {
      const found = cards.filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    });
    db.bill.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (
      bills.filter((row) => matches(row, where))
    ));
    db.billCard.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (
      links.filter((row) => matches(row, where))
    ));
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const { task, ...criteria } = where;
      return (task ? history : items).filter((row) => matches(row, criteria)).map((row) => ({ ...row }));
    });
    db.upgradeTaskItem.createMany.mockImplementation(async ({ data }: { data: Array<Partial<TaskItem>> }) => {
      for (const row of data) items.push({
        id: items.length + 10, taskId: 5, itemKey: '', payload: null,
        status: 'pending', processedAt: null, error: null, ...row,
      });
      return { count: data.length };
    });
    db.upgradeTaskItem.update.mockImplementation(async ({ where, data }: {
      where: { id: number }; data: Partial<TaskItem>;
    }) => {
      const found = items.find((row) => row.id === where.id)!;
      Object.assign(found, data);
      return { ...found };
    });
    db.upgradeTaskItem.count.mockImplementation(async () => items.length);
    db.upgradeTaskItem.groupBy.mockImplementation(async () => (
      [...new Set(items.map((row) => row.status))].map((status) => ({
        status, _count: items.filter((row) => row.status === status).length,
      }))
    ));
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  });

  it('使用新的 0.7.1 可选迁移身份', () => {
    expect(migration.key).toBe('supplementary-link-repair-v2');
    expect(migration.targetVersion).toBe('0.7.1');
    expect(migration.mode).toBe('optional');
  });

  it('旧迁移已经建立错误关联时仍进入 0.7.1 计划', async () => {
    expect((await migration.inspect(db as never))?.total).toBe(1);
    expect(db.card.updateMany).not.toHaveBeenCalled();
    expect(db.upgradeTaskItem.createMany).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed'])('旧明细为 %s 且当前仍是旧快照时可以纠错', async (status) => {
    history[0].status = status;
    expect((await migration.inspect(db as never))?.total).toBe(1);
  });

  it('缺失关联且未执行过旧迁移时进入计划', async () => {
    cards[1].businessPrimaryId = null;
    history = [];
    expect((await migration.inspect(db as never))?.total).toBe(1);
  });

  it('已经正确关联的用户不弹新迁移', async () => {
    cards[1].businessPrimaryId = 446;
    cards[1].businessRelationDate = september;
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('没有旧任务证据时保留已有合法关系', async () => {
    history = [];
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('旧任务忽略或无需修改的明细不作为错误写入证据', async () => {
    history[0].status = 'unchanged';
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('仅有迁移之后收到或重建的账单时不误报旧迁移错误', async () => {
    bills[1].updatedAt = new Date('2026-10-19T00:00:00+08:00');
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('迁移后关系已由新账单确认时不覆盖', async () => {
    cards[1].businessRelationDate = new Date('2026-10-18T12:00:00+08:00');
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('主卡不变而证据月份更新不让正确用户再弹提示', async () => {
    bills[1].cardId = 444;
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('旧任务参数损坏时不猜测已有关系应当如何修改', async () => {
    history[0].payload = { cardId: 445 };
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('执行纠正错误关联，并使用最新承接卡当前规则', async () => {
    await migration.prepareTask!(5);
    cards[2].statementDay = 7;
    expect(await migration.executeTask!(5)).toEqual({ succeeded: 1, unchanged: 0, failed: 0, error: undefined });
    expect(cards[1]).toMatchObject({
      businessPrimaryId: 446, businessRelationDate: september, statementDay: 7, dueOffsetDays: 25,
    });
    expect(items[0].status).toBe('succeeded');
  });

  it('等待执行期间证据又更新时，仍以本次最新有效证据写入', async () => {
    await migration.prepareTask!(5);
    const october = new Date('2026-10-18T00:00:00+08:00');
    cards.push(card(448));
    bills.push({ id: 103, cardId: 448, period: '2026-10', statementDate: october, updatedAt: october });
    links.push({ billId: 103, cardId: 445 });
    expect((await migration.executeTask!(5)).succeeded).toBe(1);
    expect(cards[1].businessPrimaryId).toBe(448);
    expect(cards[1].businessRelationDate).toEqual(october);
  });

  it('准备后关联被其他流程修正时记 unchanged', async () => {
    await migration.prepareTask!(5);
    cards[1].businessPrimaryId = 446;
    cards[1].businessRelationDate = september;
    cards[1].statementDay = 9;
    expect(await migration.executeTask!(5)).toEqual({ succeeded: 0, unchanged: 1, failed: 0, error: undefined });
    expect(cards[1].statementDay).toBe(9);
    expect(db.card.updateMany).not.toHaveBeenCalled();
  });

  it('事务复核后发生并发关系修改时，原子写入不覆盖新关系', async () => {
    db.card.findUnique.mockImplementationOnce(async () => {
      cards[1].businessPrimaryId = 999;
      cards[1].businessRelationDate = processedAt;
      return cards[2];
    });
    expect(await migration.executeTask!(5)).toEqual({ succeeded: 0, unchanged: 1, failed: 0, error: undefined });
    expect(cards[1].businessPrimaryId).toBe(999);
    expect(cards[1].businessRelationDate).toEqual(processedAt);
  });

  it('关联提交后状态记录失败，重试不再覆盖已修复卡片', async () => {
    const save = db.upgradeTaskItem.update.getMockImplementation()!;
    let failOnce = true;
    db.upgradeTaskItem.update.mockImplementation(async (args: { where: { id: number }; data: Partial<TaskItem> }) => {
      if (args.data.status === 'succeeded' && failOnce) {
        failOnce = false;
        throw new Error('状态写入暂时失败');
      }
      return save(args);
    });
    expect((await migration.executeTask!(5)).failed).toBe(1);
    expect(cards[1].businessPrimaryId).toBe(446);
    cards[1].statementDay = 9;
    expect(await migration.executeTask!(5)).toEqual({ succeeded: 0, unchanged: 1, failed: 0, error: undefined });
    expect(cards[1].statementDay).toBe(9);
    expect(db.card.updateMany).toHaveBeenCalledTimes(1);
  });

  it('同库混有错误、未关联和正确卡片时只处理前两类', async () => {
    cards.push({ ...card(449), businessRole: 'supplementary' });
    cards.push({ ...card(450, 446), businessRole: 'supplementary', businessRelationDate: september, statementDay: 9 });
    links.push({ billId: 102, cardId: 449 }, { billId: 102, cardId: 450 });
    expect((await migration.inspect(db as never))?.total).toBe(2);
    expect((await migration.executeTask!(5)).succeeded).toBe(2);
    expect(items.map((row) => row.itemKey)).toEqual(['card:445', 'card:449']);
    expect(cards.find((row) => row.id === 450)?.statementDay).toBe(9);
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('修复后重复执行不重写规则，也不再命中只读盘点', async () => {
    expect((await migration.executeTask!(5)).succeeded).toBe(1);
    cards[1].statementDay = 9;
    expect((await migration.executeTask!(5)).succeeded).toBe(1);
    expect(db.card.updateMany).toHaveBeenCalledTimes(1);
    expect(cards[1].statementDay).toBe(9);
    expect(await migration.inspect(db as never)).toBeNull();
  });

  it('缺失关联但无有效账单证据时不提示', async () => {
    cards[1].businessPrimaryId = null;
    links = [];
    history = [];
    expect(await migration.inspect(db as never)).toBeNull();
  });
});
