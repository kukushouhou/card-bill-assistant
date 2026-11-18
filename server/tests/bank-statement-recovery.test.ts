import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  mailLog: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  card: { findMany: vi.fn() }, bill: { findMany: vi.fn(), findFirst: vi.fn() }, billTransaction: { count: vi.fn() },
  upgradeTask: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  upgradeTaskItem: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  $transaction: vi.fn(), $queryRawUnsafe: vi.fn(),
}));
const reader = vi.hoisted(() => ({ open: vi.fn(), fetch: vi.fn(), close: vi.fn(), release: vi.fn() }));
const apply = vi.hoisted(() => vi.fn());
const repair = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/modules/email/email.service', () => ({ openAccountMailReader: reader.open, acquireEmailAccountLock: () => reader.release }));
vi.mock('../src/parsers/pipeline', async importOriginal => ({
  ...await importOriginal<typeof import('../src/parsers/pipeline')>(), applyParsedBillsInTransaction: apply,
}));
vi.mock('../src/modules/upgrades/migrations/statement-repair', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/upgrades/migrations/statement-repair')>(), repairStatementMail: repair,
}));
import { cgbStatements085Migration as migration, pabDetails085Migration, cmbcDetails085Migration, repairBankStatementMail } from '../src/modules/upgrades/migrations/repair-bank-statements-085';
import { emptyRepairCounts } from '../src/modules/upgrades/migrations/statement-repair';
import { MailboxUnavailableError } from '../src/modules/email/mail-reader-error';
import { ApiError } from '../src/lib/errors';
import { fromYmd } from '../src/lib/dates';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import type { ParsedBill } from '../src/parsers/types';

const date = fromYmd('2026-11-18');
const tx = db as unknown as Prisma.TransactionClient;
const itemMail = (id: number) => ({ mailLogId: id, accountId: id === 3 ? 2 : 1, uid: id, bankName: '广发银行',
  parserId: null, status: 'unmatched', processedAt: date.toISOString(), billIds: [] as number[], targets: [] });
const bill: ParsedBill = { bankName: '广发银行', cardLast4: '9001', period: '2026-07', amount: 100, minAmount: 10,
  currency: 'CNY', statementDate: fromYmd('2026-07-24'), dueDate: fromYmd('2026-08-15'), transactions: [] };
const source = { from: 'creditcard@cgbchina.com.cn', subject: '【广发卡7月账单】超级广发日', date: date.toISOString(),
  text: '账单周期：2026/06/25-2026/07/24', html: '<table><tr><td>9001</td><td>100.00</td><td>10.00</td><td>2026/08/15</td><td>人民币</td></tr></table>' };
type Item = { id: number; status: string; payload: Record<string, unknown>; error?: string | null };
let items: Item[];
let logs: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.resetAllMocks();
  items = [1, 2, 3].map(id => ({ id, status: 'pending', payload: itemMail(id) }));
  logs = [1, 2, 3].map(id => ({ ...itemMail(id), id, processedAt: date, bills: [], fromAddress: source.from, subject: source.subject }));
  db.mailLog.findMany.mockResolvedValue(logs);
  db.mailLog.findUnique.mockImplementation(async ({ where }) => logs.find(log => log.id === where.id));
  db.mailLog.update.mockImplementation(async ({ where, data }) => Object.assign(logs.find(log => log.id === where.id)!, data));
  db.upgradeTask.findUniqueOrThrow.mockResolvedValue({ payload: { anchor: date.toISOString(), banks: [], preserveCardRuleIds: [7] } });
  db.upgradeTaskItem.findMany.mockImplementation(async ({ where }) => items.filter(item =>
    (!where.id?.in || where.id.in.includes(item.id)) && (!where.status?.in || where.status.in.includes(item.status))));
  db.upgradeTaskItem.findUniqueOrThrow.mockImplementation(async ({ where }) => items.find(item => item.id === where.id));
  db.upgradeTaskItem.update.mockImplementation(async ({ where, data }) => Object.assign(items.find(item => item.id === where.id)!, data));
  db.upgradeTaskItem.groupBy.mockImplementation(async () => [...new Set(items.map(item => item.status))]
    .map(status => ({ status, _count: items.filter(item => item.status === status).length })));
  db.$transaction.mockImplementation(async run => run(db));
  db.card.findMany.mockResolvedValue([]);
  db.bill.findMany.mockResolvedValue([]);
  db.bill.findFirst.mockResolvedValue(null);
  db.billTransaction.count.mockResolvedValue(1);
  reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
  reader.close.mockResolvedValue(undefined);
  reader.fetch.mockResolvedValue(source);
  apply.mockResolvedValue([101]);
  repair.mockResolvedValue({ ...emptyRepairCounts(), correctedBills: 2, addedTransactions: 1, removedTransactions: 1 });
});

describe('银行历史恢复任务', () => {
  it('无候选不入场，广发盘点须命中真实发件人及账单标题', async () => {
    db.mailLog.findMany.mockResolvedValueOnce([]);
    expect(await migration.inspect(db as unknown as PrismaClient)).toBeNull();
    logs[0]!.fromAddress = 'person@example.test';
    logs[1]!.subject = '广发最新营销活动';
    expect((await migration.inspect(db as unknown as PrismaClient))?.total).toBe(1);
    db.mailLog.findMany.mockResolvedValueOnce([]);
    await cmbcDetails085Migration.inspect(db as unknown as PrismaClient);
    expect(db.mailLog.findMany.mock.lastCall?.[0].where).toMatchObject({ status: 'matched',
      bills: { some: { source: 'email', currency: 'USD', hasDetails: false } } });
  });

  it('平安和民生分别盘点与准备，候选邮件和任务项按银行独立归属', async () => {
    const bankLogs = [
      { ...logs[0], parserId: 'pab2019', status: 'matched', bills: [{ id: 11, cardId: 5, period: bill.period, currency: 'USD', card: { bankName: '平安银行' } }] },
      { ...logs[1], parserId: 'cmbc2026', status: 'matched', bills: [{ id: 12, cardId: 6, period: bill.period, currency: 'USD', card: { bankName: '民生银行' } }] },
    ];
    db.mailLog.findMany.mockImplementation(async ({ where }) => bankLogs.filter(log => where.parserId.in.includes(log.parserId)));
    const pab = await pabDetails085Migration.inspect(db as unknown as PrismaClient);
    const cmbc = await cmbcDetails085Migration.inspect(db as unknown as PrismaClient);
    expect(pab).toMatchObject({ total: 1, payload: { banks: [{ bankName: '平安银行', mailCount: 1 }] } });
    expect(cmbc).toMatchObject({ total: 1, payload: { banks: [{ bankName: '民生银行', mailCount: 1 }] } });
    expect(db.mailLog.findMany.mock.calls[0]![0].where).toMatchObject({ parserId: { in: ['pab2019', 'pab2026'] },
      bills: { some: { card: { bankName: '平安银行' } } } });
    expect(db.mailLog.findMany.mock.calls[1]![0].where).toMatchObject({ parserId: { in: ['cmbc2026'] },
      bills: { some: { card: { bankName: '民生银行' } } } });
    expect(pabDetails085Migration.describeImpact!(pab!)).not.toContain('民生');
    expect(cmbcDetails085Migration.describeImpact!(cmbc!)).not.toContain('平安');
    db.upgradeTaskItem.count.mockResolvedValue(0);
    await pabDetails085Migration.prepareTask!(91);
    await cmbcDetails085Migration.prepareTask!(92);
    expect(db.upgradeTaskItem.createMany.mock.calls[0]![0].data).toMatchObject([{ taskId: 91, payload: { bankName: '平安银行', parserId: 'pab2019' } }]);
    expect(db.upgradeTaskItem.createMany.mock.calls[1]![0].data).toMatchObject([{ taskId: 92, payload: { bankName: '民生银行', parserId: 'cmbc2026' } }]);
    bankLogs.pop();
    expect(await cmbcDetails085Migration.inspect(db as unknown as PrismaClient)).toBeNull();
    expect((await pabDetails085Migration.inspect(db as unknown as PrismaClient))?.total).toBe(1);
  });

  it('准备任务保留原盘点时间和现有卡片规则，重试复用任务项', async () => {
    db.upgradeTaskItem.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    db.card.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    await migration.prepareTask!(8);
    expect(db.mailLog.findMany.mock.calls[0]![0].where.processedAt).toEqual({ lte: date });
    expect(db.upgradeTask.update.mock.lastCall?.[0].data.payload.preserveCardRuleIds).toEqual([7, 8]);
    await migration.prepareTask!(8);
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('补录复用正常合账，完成状态与来源更新同事务提交，重试不重复', async () => {
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 3, unchanged: 0, failed: 0 });
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls[0]![4]).toEqual(new Set([7]));
    expect(db.$transaction.mock.calls[0]?.[1]).toMatchObject({ isolationLevel: 'Serializable' });
    expect(logs[0]).toMatchObject({ status: 'matched', parserId: 'cgb2026', error: null });
    await migration.executeTask!(8);
    expect(reader.fetch).toHaveBeenCalledTimes(3);
  });

  it('同卡同账期已有手工或其他来源账单时不重复补录', async () => {
    db.bill.findMany.mockResolvedValue([{ period: bill.period, currency: bill.currency, card: { cardLast4: bill.cardLast4 }, source: 'manual' }]);
    expect(await repairBankStatementMail(tx, 'cgb-statements', itemMail(1), [bill], 'cgb2026')).toMatchObject({ addedBills: 0 });
    expect(apply).not.toHaveBeenCalled();
  });

  it('续跑期间新同步卡片已有更新账单时同样保护当前规则', async () => {
    db.card.findMany.mockResolvedValue([{ id: 99 }]);
    await repairBankStatementMail(tx, 'cgb-statements', itemMail(1), [bill], 'cgb2026', [7]);
    expect(apply.mock.lastCall?.[4]).toEqual(new Set([7, 99]));
  });

  it.each(['missing', 'parse'])('单封 %s 跳过后继续其他邮件', async reason => {
    if (reason === 'missing') reader.fetch.mockRejectedValueOnce(new ApiError(404, '邮件不存在'));
    else reader.fetch.mockResolvedValueOnce({ ...source, text: '残缺账单', html: null });
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 2, unchanged: 1, failed: 0 });
    expect(items[0]).toMatchObject({ payload: { result: { unavailableMails: 1 } } });
  });

  it('邮箱失败保留其他邮箱已完成结果，恢复后只续跑待处理项', async () => {
    reader.open.mockImplementation(async (id: number) => {
      if (id === 1) throw new MailboxUnavailableError();
      return { fetch: reader.fetch, close: reader.close };
    });
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 1, failed: 2 });
    reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 3, failed: 0 });
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it('数据库故障保留任务待处理状态，不误报邮箱问题', async () => {
    apply.mockRejectedValueOnce(new Error('数据库冲突'));
    await expect(migration.executeTask!(8)).rejects.toThrow('数据库冲突');
    expect(items[0]?.status).toBe('pending');
    expect(logs[0]?.status).toBe('unmatched');
  });
});

describe('外币明细迁移的现有数据保护', () => {
  function foreignMail() {
    const bankName = '民生银行';
    const cny = { ...bill, bankName, transactions: [] };
    const usd = { ...bill, bankName, currency: 'USD', cardLast4: '9002', transactions: [{ date: '07/01', description: '境外消费', amount: 10, currency: 'USD', cardLast4: '9002' }] };
    const targets = [{ id: 11, cardId: 5, period: bill.period, currency: 'CNY' }, { id: 12, cardId: 5, period: bill.period, currency: 'USD' }];
    const mail = { ...itemMail(1), bankName, status: 'matched', parserId: 'cmbc2026', billIds: [11, 12], targets };
    logs[0] = { ...logs[0], status: 'matched', parserId: 'cmbc2026', bills: targets.map(target => ({ ...target,
      source: 'email', statementDate: bill.statementDate, dueDate: bill.dueDate, amount: bill.amount, minAmount: bill.minAmount,
      card: { bankName, cardLast4: '9001' }, paidStatus: 'partial', paidAmount: 5,
      transactions: target.currency === 'CNY' ? [{ dateText: '07/01', description: '境外消费', amount: 10, currency: 'CNY' }] : [],
    })) };
    return { mail, parsed: [cny, usd] };
  }

  it('错记人民币的美元交易计为修正，已有还款决定传给既有修复流程保留', async () => {
    const { mail, parsed } = foreignMail();
    const result = await repairBankStatementMail(tx, 'cmbc-details', mail, parsed, 'cmbc2026');
    expect(result).toMatchObject({ addedTransactions: 0, removedTransactions: 0, correctedTransactions: 1 });
    expect(repair.mock.lastCall?.[1]).toMatchObject({ preserveRepayments: true, billIds: [11, 12] });
  });

  it('摘要不一致、用户删除、其他来源已占用目标时均保留当前数据', async () => {
    const { mail, parsed } = foreignMail();
    await repairBankStatementMail(tx, 'cmbc-details', mail, [{ ...parsed[0]!, amount: 200 }, parsed[1]!], 'cmbc2026');
    expect(repair).not.toHaveBeenCalled();
    db.bill.findFirst.mockResolvedValue({ id: 99 });
    await repairBankStatementMail(tx, 'cmbc-details', mail, parsed, 'cmbc2026');
    expect(repair).not.toHaveBeenCalled();
    logs[0]!.bills = [];
    await repairBankStatementMail(tx, 'cmbc-details', mail, parsed, 'cmbc2026');
    expect(repair).not.toHaveBeenCalled();
  });

  it('原文没有美元交易的正常零余额账单只记已复核', async () => {
    const { mail, parsed } = foreignMail();
    parsed[1]!.transactions = [];
    expect(await repairBankStatementMail(tx, 'cmbc-details', mail, parsed, 'cmbc2026')).toMatchObject({ correctedBills: 0 });
    expect(repair).not.toHaveBeenCalled();
    expect(db.mailLog.update).not.toHaveBeenCalled();
  });
});
