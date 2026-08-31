import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  mailLog: { findMany: vi.fn(), findUnique: vi.fn() },
  upgradeTask: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  upgradeTaskItem: { findMany: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
  card: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  $transaction: vi.fn(),
}));
const parserMocks = vi.hoisted(() => ({
  list: vi.fn(),
  tryParse: vi.fn(),
}));
const emailMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  openReader: vi.fn(),
}));
const applyParsedBills = vi.hoisted(() => vi.fn());
const recomputePrimary = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/parsers/registry', () => ({
  listBusinessRelationshipParsers: parserMocks.list,
  tryParse: parserMocks.tryParse,
}));
vi.mock('../src/parsers/pipeline', () => ({ applyParsedBills }));
vi.mock('../src/modules/email/email.service', () => ({
  acquireEmailAccountLock: emailMocks.acquire,
  openAccountMailReader: emailMocks.openReader,
}));
vi.mock('../src/lib/card-groups', () => ({ recomputePrimary }));

import { ApiError } from '../src/lib/errors';
import { APP_VERSION } from '../src/version';
import { initializeUpgradeState, startUpgradeTask } from '../src/modules/upgrades/upgrade.service';

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    key: 'card-business-relations-v1',
    fromVersion: null,
    toVersion: APP_VERSION,
    banks: ['工商银行'],
    status: 'pending',
    total: 1,
    processed: 0,
    updated: 0,
    missing: 0,
    failed: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('主副卡历史账单升级任务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    db.upgradeTask.findMany.mockResolvedValue([]);
    db.upgradeTask.findUnique.mockResolvedValue(task());
    db.upgradeTask.create.mockResolvedValue(task({ id: 5 }));
    db.upgradeTask.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...task(),
      ...data,
    }));
    db.upgradeTaskItem.findMany.mockResolvedValue([]);
    db.upgradeTaskItem.groupBy.mockResolvedValue([]);
    db.mailLog.findMany.mockResolvedValue([]);
    db.mailLog.findUnique.mockResolvedValue({ id: 77 });
    db.card.findMany.mockResolvedValue([]);
    parserMocks.list.mockReturnValue([
      { id: 'icbc2026', bankName: '工商银行' },
      { id: 'pab2026', bankName: '平安银行' },
      { id: 'cgb2026', bankName: '广发银行' },
    ]);
    emailMocks.acquire.mockReturnValue(vi.fn());
    emailMocks.openReader.mockResolvedValue({ fetch: vi.fn(), close: vi.fn(async () => undefined) });
    recomputePrimary.mockResolvedValue(undefined);
  });

  it('旧安装只为数据库已记录的明确模板生成一次合并询问', async () => {
    db.appSetting.findUnique.mockResolvedValue(null);
    db.upgradeTask.findUnique.mockResolvedValueOnce(null);
    db.mailLog.findMany.mockResolvedValue([
      { accountId: 1, uid: 10, parserId: 'icbc2026' },
      { accountId: 1, uid: 11, parserId: 'pab2026' },
      { accountId: 1, uid: 12, parserId: 'icbc2026' },
    ]);

    await initializeUpgradeState(true);

    expect(db.mailLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { parserId: { in: ['icbc2026', 'pab2026', 'cgb2026'] }, status: 'matched' },
    }));
    expect(db.upgradeTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'card-business-relations-v1',
        banks: ['工商银行', '平安银行'],
        total: 3,
      }),
    });
    expect(db.upgradeTaskItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ accountId: 1, uid: 10, bankName: '工商银行' }),
        expect.objectContaining({ accountId: 1, uid: 11, bankName: '平安银行' }),
      ]),
    });
    expect(db.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'installedVersion' },
      create: { key: 'installedVersion', value: APP_VERSION },
      update: { value: APP_VERSION },
    });
  });

  it('邮件已删除时跳过该邮件并完成任务，不改写原账单', async () => {
    const fetch = vi.fn().mockRejectedValue(new ApiError(404, '邮件不存在'));
    emailMocks.openReader.mockResolvedValue({ fetch, close: vi.fn(async () => undefined) });
    db.upgradeTaskItem.findMany
      .mockResolvedValueOnce([{ id: 1, taskId: 20, accountId: 1, uid: 10, parserId: 'icbc2026' }])
      .mockResolvedValueOnce([{ bankName: '工商银行', status: 'missing' }]);
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'missing', _count: 1 }]);

    await startUpgradeTask('card-business-relations-v1');
    await vi.waitFor(() => {
      expect(db.upgradeTask.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', missing: 1, failed: 0 }),
      }));
    });

    expect(db.upgradeTaskItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'missing', error: null }),
    }));
    expect(applyParsedBills).not.toHaveBeenCalled();
  });

  it('邮件存在但解析失败时保留旧数据并标记可重试失败', async () => {
    emailMocks.openReader.mockResolvedValue({
      fetch: vi.fn().mockResolvedValue({
        uid: 10,
        from: 'bank@example.com',
        subject: '账单',
        date: new Date().toISOString(),
        text: '内容',
        html: null,
        pdfText: null,
        attachText: null,
        attachments: [],
      }),
      close: vi.fn(async () => undefined),
    });
    parserMocks.tryParse.mockReturnValue({ matched: false, reason: '模板不匹配' });
    db.upgradeTaskItem.findMany.mockResolvedValueOnce([
      { id: 2, taskId: 21, accountId: 1, uid: 10, parserId: 'icbc2026' },
    ]);
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'failed', _count: 1 }]);
    db.upgradeTask.findUnique.mockResolvedValue(task({ id: 21 }));
    db.upgradeTask.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...task({ id: 21 }),
      ...data,
    }));

    await startUpgradeTask('card-business-relations-v1');
    await vi.waitFor(() => {
      expect(db.upgradeTask.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 21 },
        data: expect.objectContaining({ status: 'failed', failed: 1 }),
      }));
    });
    expect(applyParsedBills).not.toHaveBeenCalled();
  });

  it('邮箱连接失败时记录该账户的未完成项并允许重试', async () => {
    emailMocks.openReader.mockRejectedValue(new Error('邮箱认证失败'));
    db.upgradeTaskItem.findMany.mockResolvedValueOnce([
      { id: 3, taskId: 22, accountId: 9, uid: 18, parserId: 'pab2026' },
    ]);
    db.upgradeTaskItem.groupBy.mockResolvedValue([{ status: 'failed', _count: 1 }]);
    db.upgradeTask.findUnique.mockResolvedValue(task({ id: 22 }));
    db.upgradeTask.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...task({ id: 22 }),
      ...data,
    }));

    await startUpgradeTask('card-business-relations-v1');
    await vi.waitFor(() => {
      expect(db.upgradeTaskItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [3] }, status: 'pending' },
        data: expect.objectContaining({ status: 'failed', error: '邮箱认证失败' }),
      });
    });
  });

  it('容器重启后自动从持久化进度继续已确认的任务', async () => {
    db.upgradeTask.findMany.mockResolvedValue([{ key: 'card-business-relations-v1' }]);
    db.appSetting.findUnique.mockResolvedValue({ value: APP_VERSION });
    db.upgradeTask.findUnique.mockResolvedValue(task({ id: 23 }));

    await initializeUpgradeState(true);
    await vi.waitFor(() => {
      expect(db.upgradeTask.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 23 },
        data: expect.objectContaining({ status: 'completed' }),
      }));
    });

    expect(db.upgradeTaskItem.updateMany).toHaveBeenCalledWith({
      where: { status: 'running' },
      data: { status: 'pending' },
    });
    expect(db.upgradeTask.updateMany).toHaveBeenCalledWith({
      where: { status: 'running' },
      data: { status: 'pending', error: null, finishedAt: null },
    });
  });
});
