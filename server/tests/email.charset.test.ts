import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { prepareRawForParser } from '../src/modules/email/email.service';

function oldAbcMail(): Buffer {
  const head = Buffer.from([
    'From: e-statement@creditcard.abchina.com',
    'Subject: ABC statement',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=""',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
  ].join('\r\n'), 'ascii');
  // “交易描述”的 GB18030/GBK 字节。
  return Buffer.concat([head, Buffer.from('bdbbd2d7c3e8caf6', 'hex')]);
}

describe('农行旧 MIME 空字符集修复', () => {
  it('仅对农行空 charset 声明改用 GB18030，正文恢复中文', async () => {
    const raw = oldAbcMail();
    const prepared = prepareRawForParser(raw, '中国农业银行 <e-statement@creditcard.abchina.com>');
    expect(prepared.toString('latin1')).toContain('charset=gb18030');
    const parsed = await simpleParser(prepared);
    expect(parsed.text).toContain('交易描述');
  });

  it('其他发件人的原始邮件不改写', () => {
    const raw = oldAbcMail();
    expect(prepareRawForParser(raw, 'other@example.com')).toBe(raw);
  });
});
