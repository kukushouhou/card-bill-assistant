import { describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { MAX_MAIL_SOURCE_BYTES, readMailSource } from '../src/modules/email/mail-source';

describe('邮件原文读取的容量边界', () => {
  it('原文和 UID 保持不变，读取指令在传输层限定最大长度', async () => {
    const message = { uid: 8, size: 5, source: Buffer.from('hello') };
    const fetchOne = vi.fn(async () => message);
    expect(await readMailSource({ fetchOne } as unknown as ImapFlow, 8, true)).toBe(message);
    expect(fetchOne).toHaveBeenCalledWith(8, { uid: true, envelope: true, size: true, source: { maxLength: MAX_MAIL_SOURCE_BYTES + 1 } }, { uid: true });
  });
  it('超限元数据和超限正文都拒绝，绝不把截断后的邮件交给解析器', async () => {
    for (const message of [
      { size: MAX_MAIL_SOURCE_BYTES + 10, source: Buffer.from('truncated') },
      { size: 1, source: Buffer.alloc(MAX_MAIL_SOURCE_BYTES + 1) },
    ]) {
      await expect(readMailSource({ fetchOne: async () => message } as unknown as ImapFlow, 9)).rejects.toMatchObject({ status: 413 });
    }
  });
  it('保持邮件不存在的语义，未要求信封时不额外加载信封', async () => {
    const fetchOne = vi.fn(async (_uid: number, _options: unknown, _flags: unknown) => false);
    expect(await readMailSource({ fetchOne } as unknown as ImapFlow, 10)).toBe(false);
    expect(fetchOne.mock.calls[0][1]).not.toHaveProperty('envelope');
  });
});
