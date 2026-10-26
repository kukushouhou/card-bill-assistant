import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  mailLog: { findUnique: vi.fn(), findMany: vi.fn() }, bill: { findMany: vi.fn(), updateMany: vi.fn() },
  upgradeTask: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  upgradeTaskItem: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  $transaction: vi.fn(), $queryRawUnsafe: vi.fn(),
}));
const reader = vi.hoisted(() => ({ open: vi.fn(), fetch: vi.fn(), close: vi.fn(), release: vi.fn(), lock: vi.fn() }));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/modules/email/email.service', () => ({ openAccountMailReader: reader.open, acquireEmailAccountLock: reader.lock }));
import { repairIcbcForeign080Migration } from '../src/modules/upgrades/migrations/repair-icbc-foreign-080';
import { MailboxUnavailableError } from '../src/modules/email/mail-reader-error';
import { ApiError } from '../src/lib/errors';
import { fromYmd } from '../src/lib/dates';
type Item = { id: number; status: string; payload: Record<string, any>; error?: string | null };
let items: Item[];
let bills: any[];
let task: any;
const body = { from: 'webmaster@icbc.com.cn', subject: '工商银行对账单', date: '2026-10-02',
  text: '贷记卡到期还款日 2026年10月25日\n对账单生成日 2026年09月30日\n需 还 款 明 细\n1111(牡丹贷记卡) 人民币 100.00/RMB 10.00/RMB\n美元 21.26/USD 2.13/USD\n合计' };
beforeEach(() => {
  vi.resetAllMocks();
  items = [1, 2, 3].map(id => ({ id, status: 'pending', payload: { accountId: id === 3 ? 2 : 1, uid: id, mailLogId: id,
    billIds: [id], targets: [{ id, cardId: id, period: '2026-09', currency: 'USD' }], parserId: 'icbc2026', bankName: '工商银行' } }));
  bills = items.map(item => ({ id: item.id, cardId: item.id, mailLogId: item.id, source: 'email', card: { bankName: '工商银行', cardLast4: '1111' },
    period: '2026-09', currency: 'USD', statementDate: fromYmd('2026-09-30'), dueDate: fromYmd('2026-10-25'),
    amount: 0, minAmount: 0, paidAmount: 0, paidStatus: 'paid', paidAt: fromYmd('2026-10-25'), updatedAt: fromYmd('2026-10-18') }));
  task = { payload: { lowerBound: fromYmd('2026-09-26').toISOString() }, startedAt: fromYmd('2026-10-26') };
  db.upgradeTask.findUniqueOrThrow.mockImplementation(async () => task);
  db.upgradeTask.update.mockImplementation(async ({ data }) => Object.assign(task, data));
  db.upgradeTaskItem.findMany.mockImplementation(async ({ where }) => items.filter(item =>
    (!where.id?.in || where.id.in.includes(item.id)) && (!where.status?.in || where.status.in.includes(item.status))));
  db.upgradeTaskItem.findUniqueOrThrow.mockImplementation(async ({ where }) => items.find(item => item.id === where.id));
  db.upgradeTaskItem.update.mockImplementation(async ({ where, data }) => Object.assign(items.find(item => item.id === where.id)!, data));
  db.upgradeTaskItem.groupBy.mockImplementation(async () => [...new Set(items.map(item => item.status))]
    .map(status => ({ status, _count: items.filter(item => item.status === status).length })));
  db.mailLog.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, accountId: where.id === 3 ? 2 : 1,
    uid: where.id, parserId: 'icbc2026', status: 'matched' }));
  db.bill.findMany.mockImplementation(async ({ where }) => bills.filter(row => where.id.in.includes(row.id)));
  db.bill.updateMany.mockImplementation(async ({ where, data }) => {
    const row = bills.find(row => row.id === where.id); if (!row) return { count: 0 };
    Object.assign(row, data); return { count: 1 };
  });
  // 模拟事务的业务与任务原子回滚，原文读取在事务外。
  db.$transaction.mockImplementation(async run => {
    const oldBills = structuredClone(bills), oldItems = structuredClone(items);
    try { return await run(db); } catch (error) { bills = oldBills; items = oldItems; throw error; }
  });
  reader.lock.mockReturnValue(reader.release);
  reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
  reader.fetch.mockResolvedValue(body); reader.close.mockResolvedValue(undefined);
});
const execute = () => repairIcbcForeign080Migration.executeTask!(8);
describe('0.8 工行逐封执行与恢复', () => {
  it('同封业务/结果原子提交，再次执行不重复修改和计数，不保存金额证据副本', async () => {
    expect(await execute()).toMatchObject({ succeeded: 3, unchanged: 0, failed: 0 });
    expect(await execute()).toMatchObject({ succeeded: 3, unchanged: 0, failed: 0 });
    expect(db.bill.updateMany).toHaveBeenCalledTimes(3);
    expect(reader.fetch).toHaveBeenCalledTimes(3);
    expect(reader.close).toHaveBeenCalledTimes(2); expect(reader.release).toHaveBeenCalledTimes(2);
    expect(items[0]!.payload.result).toMatchObject({ correctedBills: 1, restoredRepayments: 1 });
    expect(JSON.stringify(items)).not.toMatch(/"before"|"after"|"paidAt"|"updatedAt"|"minAmount"|"text"/);
  });
  it.each(['missing', 'parse', 'read'])('单封 %s 跳过，保留其他结果与资源释放', async reason => {
    if (reason === 'missing') reader.fetch.mockRejectedValueOnce(new ApiError(404, '邮件不存在'));
    if (reason === 'read') reader.fetch.mockRejectedValueOnce(new Error('单封原文异常'));
    if (reason === 'parse') reader.fetch.mockResolvedValueOnce({ ...body, text: '无账单内容' });
    expect(await execute()).toMatchObject({ succeeded: 2, unchanged: 1, failed: 0 });
    expect(items[0]!.payload.result.unavailableMails).toBe(1);
    expect(bills[0].amount).toBe(0);
    expect(reader.release).toHaveBeenCalledTimes(2);
  });
  it('全部原文缺失也能完成，邮箱解绑同样跳过', async () => {
    reader.fetch.mockRejectedValue(new ApiError(404, '邮件不存在'));
    expect(await execute()).toMatchObject({ succeeded: 0, unchanged: 3, failed: 0 });
    items.forEach(item => { item.status = 'pending'; });
    reader.open.mockRejectedValue(new ApiError(404, '邮箱账户不存在'));
    expect(await execute()).toMatchObject({ unchanged: 3, failed: 0 });
  });
  it('整箱失败其他邮箱继续，重试新还款与删除优先，固定窗口不移动', async () => {
    reader.open.mockImplementation(async id => { if (id === 1) throw new MailboxUnavailableError(); return { fetch: reader.fetch, close: reader.close }; });
    expect(await execute()).toMatchObject({ succeeded: 1, failed: 2 });
    bills[0].paidStatus = 'partial'; bills[0].paidAmount = 2; bills[0].paidAt = fromYmd('2026-10-26');
    bills = bills.filter(bill => bill.id !== 2);
    reader.open.mockResolvedValue({ fetch: reader.fetch, close: reader.close });
    expect(await execute()).toMatchObject({ succeeded: 2, unchanged: 1, failed: 0 });
    expect(bills[0]).toMatchObject({ amount: 21.26, paidStatus: 'partial', paidAmount: 2 });
    expect(items[1]!.payload.result.skippedBills).toBe(1);
    expect(task.payload.lowerBound).toBe(fromYmd('2026-09-26').toISOString());
  });
  it('执行中断连释放并保留完成项', async () => {
    reader.fetch.mockResolvedValueOnce(body).mockRejectedValueOnce(new MailboxUnavailableError());
    expect(await execute()).toMatchObject({ succeeded: 2, failed: 1 });
    expect(items.map(item => item.status)).toEqual(['succeeded', 'failed', 'succeeded']);
    expect(reader.close).toHaveBeenCalledTimes(2); expect(reader.release).toHaveBeenCalledTimes(2);
  });
  it('任务终态写入失败回滚该封金额，重试可正常完成', async () => {
    db.upgradeTaskItem.update.mockRejectedValueOnce(new Error('数据库写入失败'));
    await expect(execute()).rejects.toThrow('数据库写入失败');
    expect(bills[0].amount).toBe(0); expect(items[0]!.status).toBe('pending');
    expect(reader.close).toHaveBeenCalledTimes(1); expect(reader.release).toHaveBeenCalledTimes(1);
    expect(await execute()).toMatchObject({ succeeded: 3, failed: 0 });
  });
  it.each(['db', 'lock'])('%s 错误不伪装邮箱故障或原文跳过', async reason => {
    const error = new Error('基础设施故障');
    if (reason === 'db') db.bill.findMany.mockRejectedValueOnce(error);
    else reader.lock.mockImplementationOnce(() => { throw error; });
    await expect(execute()).rejects.toBe(error);
    expect(items.every(item => item.status === 'pending')).toBe(true);
    expect(items.every(item => !item.payload.failureKind)).toBe(true);
  });
  it('首次准备按 startedAt 固定边界，跨日重新准备保留原边界', async () => {
    task.payload = { banks: [] }; items = [];
    db.upgradeTaskItem.count.mockImplementation(async () => items.length);
    db.mailLog.findMany.mockResolvedValue([{ id: 10, accountId: 1, uid: 20, bills: [{ id: 1, cardId: 1, period: '2026-09', currency: 'USD', dueDate: fromYmd('2026-10-25') }] }]);
    db.upgradeTaskItem.createMany.mockImplementation(async ({ data }) => { items.push(...data.map((x: any) => ({ id: 1, status: 'pending', ...x }))); });
    await repairIcbcForeign080Migration.prepareTask!(8);
    const fixed = task.payload.lowerBound;
    task.startedAt = fromYmd('2026-11-20');
    await repairIcbcForeign080Migration.prepareTask!(8);
    expect(task.payload.lowerBound).toBe(fixed);
    expect(fixed).toBe(fromYmd('2026-09-26').toISOString());
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledTimes(1);
  });
  it('共用执行器不把0.5重试策略扩展给工行，关闭异常仍释放邮箱锁', async () => {
    reader.open.mockImplementation(async id => { if (id === 1) throw new MailboxUnavailableError(); return { fetch: reader.fetch, close: reader.close }; });
    reader.close.mockRejectedValue(new Error('关闭失败'));
    expect(await execute()).toMatchObject({ succeeded: 1, failed: 2 });
    expect(reader.open).toHaveBeenCalledTimes(2);
    expect(reader.release).toHaveBeenCalledTimes(2);
    expect(db.upgradeTaskItem.update.mock.calls.filter(([args]) => args.data.status === 'failed')).toHaveLength(2);
  });
});
