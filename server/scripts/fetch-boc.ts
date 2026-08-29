// 临时调研脚本：拉取中行账单邮件，保存 PDF 附件并提取文本（用完即删）
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/config';
import { decrypt } from '../src/lib/crypto';
import { extractText, getDocumentProxy } from 'unpdf';

async function main() {
  const account = await prisma.emailAccount.findFirst();
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
    const msg = await client.fetchOne(1320912331, { uid: true, source: true }, { uid: true });
    if (!msg?.source) throw new Error('mail not found');
    const parsed = await simpleParser(msg.source);
    console.log(
      'attachments:',
      (parsed.attachments || []).map((a) => `${a.filename || '(noname)'} | ${a.contentType} | ${a.content?.length ?? 0}B`),
    );
    for (const a of parsed.attachments || []) {
      if (a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || '')) {
        fs.writeFileSync('f:/JavaScript/到期提醒助手/.trae/research/boc.pdf', a.content);
        const pdf = await getDocumentProxy(new Uint8Array(a.content));
        const { text, totalPages } = await extractText(pdf, { mergePages: true });
        fs.writeFileSync('f:/JavaScript/到期提醒助手/.trae/research/boc-pdf.txt', text);
        console.log(`PDF saved: ${totalPages} pages, ${text.length} chars`);
      }
    }
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
