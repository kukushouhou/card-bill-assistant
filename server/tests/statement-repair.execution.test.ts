import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  upgradeTask: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  upgradeTaskItem: { findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  $transaction: vi.fn(),
}));
const reader = vi.hoisted(() => ({ open: vi.fn(), fetch: vi.fn(), close: vi.fn(), release: vi.fn() }));
const parse = vi.hoisted(() => vi.fn());
const repair = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/modules/email/email.service', () => ({ openAccountMailReader: reader.open, acquireEmailAccountLock: () => reader.release }));
vi.mock('../src/parsers/registry', () => ({ tryParse: parse, getParserById: vi.fn() }));
vi.mock('../src/modules/upgrades/migrations/statement-repair', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/upgrades/migrations/statement-repair')>(), repairStatementMail: repair,
}));
import { repairStatements050Migration } from '../src/modules/upgrades/migrations/repair-statements-050';
import { emptyRepairCounts } from '../src/modules/upgrades/migrations/statement-repair';
import { MailboxUnavailableError } from '../src/modules/email/mail-reader-error';
import { ApiError } from '../src/lib/errors';

type Item = { id: number; status: string; error?: string | null; payload: Record<string, unknown> };
let items: Item[];
const execute = () => repairStatements050Migration.executeTask!(8);
beforeEach(() => {
  vi.resetAllMocks();
  items = [1, 2, 3].map(id => ({ id, status: 'pending', payload: {
    accountId: id === 3 ? 2 : 1, uid: id, mailLogId: id, billIds: [id], parserId: 'abc2026', bankName: '农业银行',
  } }));
  db.upgradeTask.findUniqueOrThrow.mockResolvedValue({ payload: { lowerBound: '2026-08-09T00:00:00+08:00' } });
  db.upgradeTaskItem.findMany.mockImplementation(async ({ where }) => items.filter(item =>
    (!where.id?.in || where.id.in.includes(item.id)) && (!where.status?.in || where.status.in.includes(item.status))));
  db.upgradeTaskItem.findUniqueOrThrow.mockImplementation(async ({ where }) => items.find(item => item.id === where.id)!);
  db.upgradeTaskItem.update.mockImplementation(async ({ where, data }) => Object.assign(items.find(item => item.id === where.id)!, data));
  db.upgradeTaskItem.groupBy.mockImplementation(async () => [...new Set(items.map(item => item.status))]
    .map(status => ({ status, _count: items.filter(item => item.status === status).length })));
  db.$transaction.mockImplementation(async run => run(db));
  reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
  reader.close.mockResolvedValue(undefined);
  reader.fetch.mockResolvedValue({ date: '2026-08-13', subject: 'synthetic', from: 'bank@example.test' });
  parse.mockReturnValue({ matched: true, bills: [{ amount: 19.85, cardLast4: '1170' }] });
  repair.mockResolvedValue({ ...emptyRepairCounts(), correctedBills: 1 });
});

describe('0.5 迁移执行的局部失败与邮箱失败边界', () => {
  it('迁移锚点仍为 0.5.0 且可忽略，不新增 0.5.1 迁移', () => {
    expect(repairStatements050Migration).toMatchObject({ key: 'statement-parser-repair-050-v1', targetVersion: '0.5.0', mode: 'optional' });
  });

  it.each(['missing', 'parse', 'read'])('单封 %s 失败直接跳过，其余邮件正常完成且不重试已处理项', async reason => {
    if (reason === 'missing') reader.fetch.mockRejectedValueOnce(new ApiError(404, '邮件不存在'));
    if (reason === 'read') reader.fetch.mockRejectedValueOnce(new Error('单封正文异常'));
    if (reason === 'parse') parse.mockReturnValueOnce({ matched: false });
    expect(await execute()).toMatchObject({ succeeded: 2, unchanged: 1, failed: 0 });
    expect(items[0]).toMatchObject({ status: 'unchanged', error: null, payload: { result: { unavailableMails: 1 } } });
    expect(repair).toHaveBeenCalledTimes(2);
    expect(await execute()).toMatchObject({ succeeded: 2, unchanged: 1, failed: 0 });
    expect(reader.fetch).toHaveBeenCalledTimes(3);
  });

  it('整箱认证失败只留下该邮箱待处理项，其他邮箱继续；修复后保留已完成结果', async () => {
    reader.open.mockImplementation(async (id: number) => {
      if (id === 1) throw new MailboxUnavailableError();
      return { fetch: reader.fetch, close: reader.close };
    });
    expect(await execute()).toMatchObject({ succeeded: 1, unchanged: 0, failed: 2 });
    expect(items[0]).toMatchObject({ status: 'failed', payload: { failureKind: 'mailbox_unavailable', accountId: 1 } });
    reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
    expect(await execute()).toMatchObject({ succeeded: 3, unchanged: 0, failed: 0 });
    expect(repair).toHaveBeenCalledTimes(3);
  });

  it('执行中确认整箱连接中断，保留已完成邮件并处理其他邮箱', async () => {
    reader.fetch.mockResolvedValueOnce({ date: '2026-08-13' }).mockRejectedValueOnce(new MailboxUnavailableError());
    expect(await execute()).toMatchObject({ succeeded: 2, unchanged: 0, failed: 1 });
    expect(items.map(item => item.status)).toEqual(['succeeded', 'failed', 'succeeded']);
  });

  it('邮箱已解绑时跳过，不要求用户重新添加已经删除的账户', async () => {
    reader.open.mockRejectedValue(new ApiError(404, '邮箱账户不存在'));
    expect(await execute()).toMatchObject({ succeeded: 0, unchanged: 3, failed: 0 });
    expect(repair).not.toHaveBeenCalled();
  });

  it('数据库读取故障不伪装成邮箱授权错误', async () => {
    const error = Object.assign(new Error('数据库暂时不可用'), { code: 'P1001' });
    reader.open.mockRejectedValue(error);
    await expect(execute()).rejects.toBe(error);
    expect(items.some(item => item.payload.failureKind === 'mailbox_unavailable')).toBe(false);
  });
});
