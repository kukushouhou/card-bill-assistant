// 临时调研脚本：拉取邮储银行账单邮件正文，定位明细解析失败原因（用完即删）
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/config';
import { decrypt } from '../src/lib/crypto';

async function main() {
  // 找最近一封邮储已匹配邮件
  const log = await prisma.mailLog.findFirst({
    where: { parserId: 'psbc2026' },
    orderBy: { uid: 'desc' },
  });
  if (!log) throw new Error('no psbc mail log');
  console.log(`mailLog #${log.id} uid=${log.uid} subject=${log.subject} date=${log.mailDate.toISOString()}`);

  const account = await prisma.emailAccount.findUnique({ where: { id: log.accountId } });
  if (!account) throw new Error('no email account');
  const password = decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc));
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.tls,
    auth: { user: account.authUser, pass: password },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne(log.uid, { uid: true, source: true }, { uid: true });
    if (!msg?.source) throw new Error('mail not found');
    const parsed = await simpleParser(msg.source);
    console.log('attachments:', (parsed.attachments || []).map((a) => `${a.filename || '(noname)'} | ${a.contentType} | ${a.content?.length ?? 0}B`));
    const out = [
      '===== TEXT PART =====',
      parsed.text ?? '(empty)',
      '\n===== HTML PART =====',
      typeof parsed.html === 'string' ? parsed.html : '(empty)',
    ].join('\n');
    fs.writeFileSync('f:/JavaScript/到期提醒助手/.trae/research/psbc-mail.txt', out);
    console.log(`saved ${out.length} chars`);
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
