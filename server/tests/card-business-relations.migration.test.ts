import { beforeEach, describe, expect, it, vi } from 'vitest';

// 运行真实迁移和邮件读取器；只替换数据库、IMAP 传输及账单落库，不连接本地业务库或邮箱。
const db = vi.hoisted(() => ({
  emailAccount: { findUnique: vi.fn() },
  mailLog: { findMany: vi.fn(), findUnique: vi.fn() },
  upgradeTaskItem: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  upgradeTask: { update: vi.fn() },
  card: { findMany: vi.fn(), delete: vi.fn(), update: vi.fn() },
}));
const imap = vi.hoisted(() => ({
  connect: vi.fn(), getMailboxLock: vi.fn(), fetchOne: vi.fn(), logout: vi.fn(), close: vi.fn(), release: vi.fn(),
}));
const parser = vi.hoisted(() => ({ tryParse: vi.fn(), applyParsedBills: vi.fn() }));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/config', () => ({ config: { encryptionKey: 'test-only' } }));
vi.mock('../src/lib/crypto', () => ({ decrypt: vi.fn(() => 'test-only'), encrypt: vi.fn() }));
vi.mock('../src/lib/card-groups', () => ({ recomputePrimary: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn(function () { return imap; }) }));
vi.mock('../src/parsers/registry', () => ({
  listBusinessRelationshipParsers: () => [{ id: 'pab2026', bankName: '平安银行' }],
  tryParse: parser.tryParse, getParserById: vi.fn(), matchParser: vi.fn(),
}));
vi.mock('../src/parsers/pipeline', () => ({ applyParsedBills: parser.applyParsedBills, applyCurrentCycleTransactions: vi.fn() }));

import { cardBusinessRelationsMigration } from '../src/modules/upgrades/migrations/card-business-relations';

type Item = {
  id: number; taskId: number; itemKey: string; status: string; error: string | null;
  payload: { accountId: number; uid: number; bankName: string; parserId: string };
};
let items: Item[];
const execute = () => cardBusinessRelationsMigration.executeTask!(8);

describe('历史卡片关系迁移的邮件缺失处理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    items = [101, 102].map((uid, i) => ({
      id: i + 1, taskId: 8, itemKey: `mail:1:${uid}`, status: 'pending', error: null,
      payload: { accountId: 1, uid, bankName: '平安银行', parserId: 'pab2026' },
    }));
    db.emailAccount.findUnique.mockResolvedValue({
      id: 1, imapHost: 'mail.example.test', imapPort: 993, tls: true, authUser: 'test', authPasswordEnc: Buffer.from('test'),
    });
    db.mailLog.findMany.mockImplementation(async () => items.map(item => item.payload));
    db.mailLog.findUnique.mockImplementation(async ({ where }) => ({ id: where.accountId_uid.uid }));
    db.upgradeTaskItem.findMany.mockImplementation(async ({ where }) =>
      items.filter(item => !where.status || where.status.in.includes(item.status)));
    db.upgradeTaskItem.count.mockImplementation(async () => items.length);
    db.upgradeTaskItem.update.mockImplementation(async ({ where, data }) => {
      const item = items.find(row => row.id === where.id)!;
      Object.assign(item, data);
      return item;
    });
    db.upgradeTaskItem.groupBy.mockImplementation(async () => {
      const statuses = [...new Set(items.map(item => item.status))];
      return statuses.map(status => ({ status, _count: items.filter(item => item.status === status).length }));
    });
    db.card.findMany.mockResolvedValue([]);
    imap.connect.mockResolvedValue(undefined);
    imap.getMailboxLock.mockResolvedValue({ release: imap.release });
    imap.logout.mockResolvedValue(undefined);
    imap.fetchOne.mockImplementation(async (uid: number) => ({
      uid, envelope: { from: [{ address: 'bill@example.test' }], subject: '测试账单', date: new Date('2026-08-01') },
      source: Buffer.from('From: bill@example.test\r\nSubject: bill\r\n\r\nTest bill'),
    }));
    parser.tryParse.mockReturnValue({ matched: true, parserId: 'pab2026', bills: [{ cardLast4: '1765' }] });
    parser.applyParsedBills.mockResolvedValue(undefined);
  });

  it('邮箱已删除一封邮件时跳过该账单、继续处理其余邮件，不报失败也不清理原卡', async () => {
    imap.fetchOne.mockResolvedValueOnce(false);

    expect(await execute()).toEqual({ succeeded: 1, unchanged: 1, failed: 0, error: undefined });
    expect(items[0]).toMatchObject({ status: 'unchanged', error: null });
    expect(items[1]).toMatchObject({ status: 'succeeded', error: null });
    expect(imap.fetchOne).toHaveBeenNthCalledWith(1, 101, { uid: true, envelope: true, size: true, source: { maxLength: 32 * 1024 * 1024 + 1 } }, { uid: true });
    expect(parser.applyParsedBills).toHaveBeenCalledTimes(1);
    expect(parser.applyParsedBills).toHaveBeenCalledWith(102, 'pab2026', expect.any(Array));
    expect(db.card.findMany).not.toHaveBeenCalled();
    expect(db.card.delete).not.toHaveBeenCalled();
    expect(db.card.update).not.toHaveBeenCalled();
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it('全部邮件已删除也正常完成，恢复执行不再重读已跳过邮件', async () => {
    imap.fetchOne.mockResolvedValue(false);
    expect(await execute()).toEqual({ succeeded: 0, unchanged: 2, failed: 0, error: undefined });
    expect(await execute()).toEqual({ succeeded: 0, unchanged: 2, failed: 0, error: undefined });
    expect(imap.fetchOne).toHaveBeenCalledTimes(2);
    expect(parser.applyParsedBills).not.toHaveBeenCalled();
  });

  it('邮件原文已无法取得时保留原账单，不要求用户重试', async () => {
    imap.fetchOne.mockResolvedValue({ envelope: { subject: '原文已不存在' } });
    expect(await execute()).toMatchObject({ succeeded: 0, unchanged: 2, failed: 0 });
    expect(parser.applyParsedBills).not.toHaveBeenCalled();
    expect(items.every(item => item.error === null)).toBe(true);
  });

  it('重试期间邮件被删除，将原失败项转为跳过并完成', async () => {
    items[0].status = 'failed';
    items[0].error = '旧连接错误';
    imap.fetchOne.mockResolvedValueOnce(false);
    expect(await execute()).toMatchObject({ succeeded: 1, unchanged: 1, failed: 0 });
    expect(items[0]).toMatchObject({ status: 'unchanged', error: null });
  });

  it('邮件日志已移除时同样跳过，不读取或重写对应账单', async () => {
    db.mailLog.findUnique.mockResolvedValueOnce(null);
    expect(await execute()).toMatchObject({ succeeded: 1, unchanged: 1, failed: 0 });
    expect(imap.fetchOne).toHaveBeenCalledTimes(1);
    expect(parser.applyParsedBills).toHaveBeenCalledWith(102, 'pab2026', expect.any(Array));
  });

  it('连接中断不能冒充邮件已删除，保留失败项供重试且不覆盖原账单', async () => {
    imap.fetchOne.mockRejectedValueOnce(new Error('连接中断'));
    expect(await execute()).toMatchObject({ succeeded: 1, unchanged: 0, failed: 1 });
    expect(items[0]).toMatchObject({ status: 'failed', error: '连接中断' });
    expect(parser.applyParsedBills).toHaveBeenCalledTimes(1);
    expect(db.card.delete).not.toHaveBeenCalled();
  });
});
