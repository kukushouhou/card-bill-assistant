import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  emailAccount: { findUnique: vi.fn(), update: vi.fn() },
  bill: { findFirst: vi.fn() },
  mailLog: { findUnique: vi.fn(), create: vi.fn() },
}));
const imap = vi.hoisted(() => ({ connect: vi.fn(), getMailboxLock: vi.fn(), search: vi.fn(), fetchAll: vi.fn(), fetchOne: vi.fn(), logout: vi.fn(), close: vi.fn(), release: vi.fn() }));
const parsed = vi.hoisted(() => ({ tryParse: vi.fn(), applyParsedBills: vi.fn() }));
vi.mock('../src/lib/prisma', () => ({ prisma: db }));
vi.mock('../src/config', () => ({ config: { encryptionKey: Buffer.alloc(32, 3) } }));
vi.mock('../src/lib/crypto', () => ({ decrypt: () => 'synthetic-password', encrypt: vi.fn() }));
vi.mock('../src/lib/card-groups', () => ({ recomputePrimary: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn(function () { return imap; }) }));
vi.mock('../src/parsers/registry', () => ({
  matchParser: (from: string) => from === 'bill@bank.test' ? { parser: { id: 'test2026', bankName: '招商银行' } } : null,
  tryParse: parsed.tryParse, getParserById: vi.fn(),
}));
vi.mock('../src/parsers/pipeline', () => ({ applyParsedBills: parsed.applyParsedBills, applyCurrentCycleTransactions: vi.fn() }));
import { syncAccount } from '../src/modules/email/email.service';
import { MAX_MAIL_SOURCE_BYTES } from '../src/modules/email/mail-source';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.emailAccount.findUnique.mockResolvedValue({ id: 1, enabled: true, lastUid: 100, imapHost: 'mail.test', imapPort: 993, tls: true, authUser: 'synthetic', authPasswordEnc: Buffer.from('test') });
  db.bill.findFirst.mockResolvedValue(null);
  db.mailLog.findUnique.mockResolvedValue(null);
  db.mailLog.create.mockResolvedValue({ id: 1 });
  imap.getMailboxLock.mockResolvedValue({ release: imap.release });
  imap.search.mockResolvedValue([101, 102]);
  imap.fetchAll.mockResolvedValue([101, 102].map(uid => ({ uid, envelope: { from: [{ address: uid === 101 ? 'bill@bank.test' : 'marketing@example.test' }], subject: '合成邮件', date: new Date('2026-09-01') } })));
  imap.fetchOne.mockResolvedValue({ size: MAX_MAIL_SOURCE_BYTES + 1, source: Buffer.from('truncated') });
  imap.logout.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('超大邮件不能阻断同步', () => {
  it('出账预读跳过超限邮件，正式同步保留错误元数据并继续后续邮件', async () => {
    expect(await syncAccount(1)).toMatchObject({ synced: 2, errors: 1, unmatched: 1 });
    expect(db.mailLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ uid: 101, status: 'error', error: expect.stringContaining('32 MiB') }) });
    expect(db.mailLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ uid: 102, status: 'unmatched' }) });
    expect(parsed.tryParse).not.toHaveBeenCalled();
    expect(parsed.applyParsedBills).not.toHaveBeenCalled();
    expect(db.emailAccount.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { lastUid: 102, lastSyncAt: expect.any(Date) } });
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
    expect(JSON.stringify(db.mailLog.create.mock.calls)).not.toContain('truncated');
  });
});
