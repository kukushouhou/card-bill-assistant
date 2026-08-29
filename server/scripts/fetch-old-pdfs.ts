// 临时调研脚本：为带 PDF 附件的样本邮件补提 PDF 文本（用完即删）
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser, type Attachment } from 'mailparser';
import fs from 'node:fs';
import { getDocumentProxy, extractText } from 'unpdf';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/config';
import { decrypt } from '../src/lib/crypto';

const OUT_DIR = 'f:/JavaScript/到期提醒助手/.trae/research/old-templates';

async function extractPdfText(attachments: Attachment[]): Promise<string | undefined> {
  const MAX_BYTES = 5 * 1024 * 1024;
  const chunks: string[] = [];
  for (const a of attachments) {
    const isPdf = a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || '');
    const content = a.content as Buffer | undefined;
    if (!isPdf || !content || content.length > MAX_BYTES) continue;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(content));
      const { text } = await extractText(pdf, { mergePages: true });
      const trimmed = text.trim();
      if (trimmed) chunks.push(trimmed.slice(0, 200_000));
    } catch {
      // ignore
    }
  }
  return chunks.length ? chunks.join('\n\n===== NEXT PDF =====\n\n') : undefined;
}

async function main() {
  const targets: Array<{ bank: string; year: string; uid: number; accountId: number }> = [];
  for (const f of fs.readdirSync(OUT_DIR).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(`${OUT_DIR}/${f}`, 'utf8'));
    if ((j.attachments ?? []).some((a: { contentType: string; filename: string }) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename ?? ''))) {
      const log = await prisma.mailLog.findFirst({ where: { uid: j.uid } });
      if (log) targets.push({ bank: f.replace(/-\d+\.json$/, '').replace(/-\d{4}$/, ''), year: '', uid: j.uid, accountId: log.accountId });
    }
  }
  console.log(`PDF 样本 ${targets.length} 封`);
  if (targets.length === 0) return;

  const account = await prisma.emailAccount.findUnique({ where: { id: targets[0]!.accountId } });
  if (!account) throw new Error('no account');
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
    for (const t of targets) {
      const msg = await client.fetchOne(t.uid, { uid: true, source: true }, { uid: true });
      if (!msg?.source) continue;
      const parsed = await simpleParser(msg.source);
      const pdfText = await extractPdfText(parsed.attachments || []);
      if (!pdfText) {
        console.log(`NOPDF ${t.uid}`);
        continue;
      }
      fs.writeFileSync(`${OUT_DIR}/pdf-${t.uid}.txt`, pdfText.slice(0, 8000));
      // 回写 json 补 pdfText 字段
      const jf = fs.readdirSync(OUT_DIR).find((x) => x.endsWith('.json') && x.includes(`-${t.uid}.`));
      if (jf) {
        const j = JSON.parse(fs.readFileSync(`${OUT_DIR}/${jf}`, 'utf8'));
        j.pdfText = pdfText.slice(0, 200_000);
        fs.writeFileSync(`${OUT_DIR}/${jf}`, JSON.stringify(j, null, 2));
      }
      console.log(`PDF ${t.uid} ${pdfText.length}B`);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
  }
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
