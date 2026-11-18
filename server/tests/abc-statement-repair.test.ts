import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  mailLog: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  upgradeTask: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  upgradeTaskItem: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  $transaction: vi.fn(), $queryRawUnsafe: vi.fn(),
}));
const reader = vi.hoisted(() => ({ open: vi.fn(), fetch: vi.fn(), close: vi.fn(), release: vi.fn() }));
const repair = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/modules/email/email.service', () => ({ openAccountMailReader: reader.open, acquireEmailAccountLock: () => reader.release }));
vi.mock('../src/modules/upgrades/migrations/statement-repair', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/upgrades/migrations/statement-repair')>(), repairStatementMail: repair,
}));
import { repairAbcStatements084Migration as migration, repairAbcStatementMail } from '../src/modules/upgrades/migrations/repair-abc-statements-084';
import { emptyRepairCounts } from '../src/modules/upgrades/migrations/statement-repair';
import { MailboxUnavailableError } from '../src/modules/email/mail-reader-error';
import { ApiError } from '../src/lib/errors';
import { fromYmd } from '../src/lib/dates';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import type { ParsedBill } from '../src/parsers/types';

const date = fromYmd('2026-11-18');
const tx = db as unknown as Prisma.TransactionClient;
const itemMail = (id: number) => ({ mailLogId: id, accountId: id === 3 ? 2 : 1, uid: id,
  bankName: '农业银行', parserId: 'abc2026', status: 'error', processedAt: date.toISOString(), billIds: [] as number[], targets: [] });
const parsed: ParsedBill[] = [{ bankName: '农业银行', cardLast4: '9001', period: '2026-11', amount: 10,
  minAmount: 0, currency: 'CNY', statementDate: fromYmd('2026-11-16'), dueDate: fromYmd('2026-12-05'), transactions: [] }];
const source = { from: 'e-statement@creditcard.abchina.com.cn', subject: '农业银行对账单', date: date.toISOString(),
  text: '卡号 Card No 622222******9001 账单周期 Statement Cycle 2026/10/17-2026/11/16 到期还款日 Payment Due Date 2026/12/05 '
    + '本期应还款额(欠款为-) New Balance 人民币(CNY) -10.00 最低还款额(欠款为-) Min Payment 人民币(CNY) 0.00' };
type Item = { id: number; status: string; payload: Record<string, unknown>; error?: string | null };
let items: Item[];
let logs: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.resetAllMocks();
  items = [1, 2, 3].map(id => ({ id, status: 'pending', payload: itemMail(id) }));
  logs = [1, 2, 3].map(id => ({ ...itemMail(id), id, processedAt: date, bills: [] }));
  db.mailLog.findMany.mockResolvedValue(logs);
  db.mailLog.findUnique.mockImplementation(async ({ where }) => logs.find(log => log.id === where.id));
  db.mailLog.update.mockImplementation(async ({ where, data }) => Object.assign(logs.find(log => log.id === where.id)!, data));
  db.upgradeTaskItem.findMany.mockImplementation(async ({ where }) => items.filter(item =>
    (!where.id?.in || where.id.in.includes(item.id)) && (!where.status?.in || where.status.in.includes(item.status))));
  db.upgradeTaskItem.findUniqueOrThrow.mockImplementation(async ({ where }) => items.find(item => item.id === where.id));
  db.upgradeTaskItem.update.mockImplementation(async ({ where, data }) => Object.assign(items.find(item => item.id === where.id)!, data));
  db.upgradeTaskItem.groupBy.mockImplementation(async () => [...new Set(items.map(item => item.status))]
    .map(status => ({ status, _count: items.filter(item => item.status === status).length })));
  db.$transaction.mockImplementation(async run => run(db));
  reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
  reader.close.mockResolvedValue(undefined);
  reader.fetch.mockResolvedValue(source);
  repair.mockResolvedValue({ ...emptyRepairCounts(), addedBills: 1 });
});

describe('农行历史恢复', () => {
  it('空盘点不入场，候选同时覆盖失败邮件和已成功的旧正文', async () => {
    db.mailLog.findMany.mockResolvedValueOnce([]);
    expect(await migration.inspect(db as unknown as PrismaClient)).toBeNull();
    const inspection = await migration.inspect(db as unknown as PrismaClient);
    expect(inspection?.total).toBe(3);
    expect(db.mailLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      OR: expect.arrayContaining([expect.objectContaining({ status: 'error' }), expect.objectContaining({ status: 'matched', parserId: 'abc2026' })]),
    }) }));
  });

  it('准备时使用最初盘点时间，重试复用既有任务项', async () => {
    db.upgradeTask.findUniqueOrThrow.mockResolvedValue({ payload: { anchor: date.toISOString(), banks: [] } });
    db.upgradeTaskItem.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    await migration.prepareTask!(8);
    expect(db.mailLog.findMany.mock.calls[0]![0].where.processedAt).toEqual({ lte: date });
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledTimes(1);
    await migration.prepareTask!(8);
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('失败邮件补建后清除错误，再次执行不会重复补建', async () => {
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 3, unchanged: 0, failed: 0 });
    expect(logs[0]).toMatchObject({ status: 'matched', error: null });
    expect(repair.mock.calls[0]![1]).toMatchObject({ allowMissingCurrencies: ['CNY'], preserveRepayments: true });
    await migration.executeTask!(8);
    expect(reader.fetch).toHaveBeenCalledTimes(3);
    expect(repair).toHaveBeenCalledTimes(3);
  });

  it.each(['missing', 'parse', 'read'])('单封 %s 失败跳过并继续其他邮件', async reason => {
    if (reason === 'missing') reader.fetch.mockRejectedValueOnce(new ApiError(404, '邮件不存在'));
    if (reason === 'read') reader.fetch.mockRejectedValueOnce(new Error('正文损坏'));
    if (reason === 'parse') reader.fetch.mockResolvedValueOnce({ ...source, text: '残缺账单' });
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 2, unchanged: 1, failed: 0 });
    expect(items[0]).toMatchObject({ payload: { result: { unavailableMails: 1 } } });
    expect(logs[0]?.status).toBe('error');
  });

  it('邮箱失效只阻塞该邮箱，恢复后续跑未完成项', async () => {
    reader.open.mockImplementation(async (accountId: number) => {
      if (accountId === 1) throw new MailboxUnavailableError();
      return { fetch: reader.fetch, close: reader.close };
    });
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 1, failed: 2 });
    reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
    expect(await migration.executeTask!(8)).toMatchObject({ succeeded: 3, failed: 0 });
    expect(repair).toHaveBeenCalledTimes(3);
  });

  it('重新同步后的来源记录不会被旧任务覆盖', async () => {
    logs[0]!.processedAt = new Date(date.getTime() + 1000);
    expect(await repairAbcStatementMail(tx, itemMail(1), parsed, 'abc2026')).toMatchObject({ addedBills: 0, reason: expect.any(String) });
    expect(repair).not.toHaveBeenCalled();
  });

  it('用户删除已有账单后不重新补建', async () => {
    const target = { id: 11, cardId: 5, cardLast4: '9001', period: '2026-11', currency: 'CNY' };
    const mail = { ...itemMail(1), status: 'matched', billIds: [11], targets: [target] };
    logs[0]!.status = 'matched';
    await repairAbcStatementMail(tx, mail, parsed, 'abc2026');
    expect(repair).not.toHaveBeenCalled();
  });

  it('已成功正文只允许补遗漏外币，并保留已有还款决定', async () => {
    const target = { id: 11, cardId: 5, cardLast4: '9001', period: '2026-11', currency: 'CNY' };
    const mail = { ...itemMail(1), status: 'matched', billIds: [11], targets: [target] };
    logs[0] = { ...logs[0], status: 'matched', bills: [{ ...target, source: 'email', statementDate: parsed[0]!.statementDate,
      dueDate: parsed[0]!.dueDate, card: { bankName: '农业银行', cardLast4: '9001' }, paidStatus: 'partial', paidAmount: 4 }] };
    await repairAbcStatementMail(tx, mail, [...parsed, { ...parsed[0]!, currency: 'USD' }], 'abc2026');
    expect(repair.mock.calls[0]![1]).toMatchObject({ allowMissingCurrencies: ['USD'], preserveRepayments: true, billIds: [11] });
  });

  it('数据库失败交给升级框架重试，保留原始错误状态', async () => {
    repair.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(migration.executeTask!(8)).rejects.toThrow('database unavailable');
    expect(logs[0]?.status).toBe('error');
    expect(items[0]?.status).toBe('pending');
  });
});
