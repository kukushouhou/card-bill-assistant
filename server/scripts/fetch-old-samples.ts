// 临时调研脚本：拉取各银行解析 error 的样本邮件（按年份分组取样），保存正文供旧模板分析（用完即删）
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/config';
import { decrypt } from '../src/lib/crypto';
import { flattenHtml } from '../src/parsers/_util';

const OUT_DIR = 'f:/JavaScript/到期提醒助手/.trae/research/old-templates';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const errs = await prisma.mailLog.findMany({
    where: { status: 'error' },
    orderBy: { mailDate: 'asc' },
  });

  // 按银行分组 → 按年份取首/中/尾样本（每家最多 3 封）
  const byParser = new Map<string, Map<string, typeof errs>>();
  for (const e of errs) {
    const year = e.mailDate?.toISOString().slice(0, 4) ?? '?';
    const years = byParser.get(e.parserId ?? '-') ?? new Map();
    years.set(year, [...(years.get(year) ?? []), e]);
    byParser.set(e.parserId ?? '-', years);
  }

  interface Sample {
    bank: string;
    year: string;
    uid: number;
    accountId: number;
    subject: string;
    from: string;
    date: Date;
  }
  const samples: Sample[] = [];
  for (const [bank, years] of byParser) {
    const yearKeys = [...years.keys()].sort();
    const picks = new Set<string>();
    if (yearKeys.length > 0) picks.add(yearKeys[0]!);
    if (yearKeys.length > 2) picks.add(yearKeys[Math.floor(yearKeys.length / 2)]!);
    if (yearKeys.length > 1) picks.add(yearKeys[yearKeys.length - 1]!);
    for (const y of picks) {
      const list = years.get(y)!;
      const first = list[0]!;
      samples.push({
        bank,
        year: y,
        uid: first.uid,
        accountId: first.accountId,
        subject: first.subject ?? '',
        from: first.fromAddress ?? '',
        date: first.mailDate ?? new Date(),
      });
    }
  }
  console.log(`共 ${samples.length} 个样本`);

  const account = await prisma.emailAccount.findFirst({ where: { id: samples[0]!.accountId } });
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
    for (const s of samples) {
      try {
        const msg = await client.fetchOne(s.uid, { uid: true, source: true }, { uid: true });
        if (!msg?.source) {
          console.log(`MISS ${s.bank} ${s.year} uid=${s.uid}`);
          continue;
        }
        const parsed = await simpleParser(msg.source);
        const html = typeof parsed.html === 'string' ? parsed.html : '';
        const flat = (parsed.text || (html ? flattenHtml(html) : ''))
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&yen;/g, '￥');
        const base = path.join(OUT_DIR, `${s.bank}-${s.year}-${s.uid}`);
        fs.writeFileSync(
          `${base}.json`,
          JSON.stringify(
            {
              uid: s.uid,
              from: s.from,
              subject: s.subject,
              date: s.date.toISOString(),
              text: parsed.text || null,
              html: html || null,
              attachments: (parsed.attachments || []).map((a) => ({
                filename: a.filename || '(noname)',
                contentType: a.contentType,
                size: a.content?.length ?? 0,
              })),
            },
            null,
            2,
          ),
        );
        fs.writeFileSync(`${base}.txt`, `FROM: ${s.from}\nSUBJECT: ${s.subject}\nDATE: ${s.date.toISOString()}\n\n${flat.slice(0, 6000)}`);
        console.log(`OK ${s.bank} ${s.year} uid=${s.uid} ${s.subject.slice(0, 40)} text=${flat.length}B att=${(parsed.attachments || []).length}`);
      } catch (err) {
        console.log(`ERR ${s.bank} ${s.year} uid=${s.uid}: ${err instanceof Error ? err.message : err}`);
      }
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
