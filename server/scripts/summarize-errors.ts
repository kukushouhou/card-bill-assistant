// 临时脚本：汇总历史拉取结果（error 分布/旧模板清单/0000 残留/P2034 冲突数），用完即删
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

async function main() {
  const total = await prisma.mailLog.count();
  const matched = await prisma.mailLog.count({ where: { status: 'matched' } });
  const unmatched = await prisma.mailLog.count({ where: { status: 'unmatched' } });
  const error = await prisma.mailLog.count({ where: { status: 'error' } });
  console.log(`MailLog ${total}：matched=${matched} unmatched=${unmatched} error=${error}`);

  // 1. error 按 parserId + 年份分布（旧模板清单）
  const errs = await prisma.mailLog.findMany({
    where: { status: 'error' },
    orderBy: { mailDate: 'asc' },
  });
  const byParser = new Map<string, { count: number; years: Set<string>; samples: string[] }>();
  for (const e of errs) {
    const year = e.mailDate?.toISOString().slice(0, 4) ?? '?';
    const key = `${e.parserId ?? '-'}`;
    const v = byParser.get(key) ?? { count: 0, years: new Set<string>(), samples: [] };
    v.count++;
    v.years.add(year);
    if (v.samples.length < 3) v.samples.push(`${year} ${e.subject?.slice(0, 30)} | ${(e.error ?? '').slice(0, 30)}`);
    byParser.set(key, v);
  }
  console.log(`\n=== 解析 error 按银行分布（${errs.length} 条）===`);
  for (const [k, v] of byParser) console.log(`${k}: ${v.count} 条（${[...v.years].sort().join(',')}）`);

  // 2. error 全部样本前 30 条
  console.log(`\n=== error 样本（前 30）===`);
  for (const e of errs.slice(0, 30)) {
    console.log(`  ${e.mailDate?.toISOString().slice(0, 10)} [${e.parserId}] ${e.subject?.slice(0, 36)} | ${(e.error ?? '').slice(0, 40)}`);
  }

  // 3. 未匹配的银行邮件（白名单外——旧域名/旧标题）
  const unmatched2 = await prisma.mailLog.findMany({
    where: { status: 'unmatched' },
  });
  const BANK_HINT = /银行|bank|credit|card|信用卡|对账单|账单/i;
  const bankUnmatched = unmatched2.filter(
    (m) => BANK_HINT.test(m.subject ?? '') || BANK_HINT.test(m.fromAddress ?? ''),
  );
  const byFrom = new Map<string, number>();
  for (const m of bankUnmatched) {
    const domain = (m.fromAddress ?? '').split('@')[1] ?? m.fromAddress;
    byFrom.set(domain, (byFrom.get(domain) ?? 0) + 1);
  }
  console.log(`\n=== 未匹配但疑似银行邮件 ${bankUnmatched.length} 条（按发件域名）===`);
  for (const [d, n] of [...byFrom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}x ${d}`);

  // 4. 0000 残留卡的账单期数
  const zeroCards = await prisma.card.findMany({ where: { cardLast4: '0000' } });
  console.log(`\n=== 0000 档案 ${zeroCards.length} 张的账单数 ===`);
  for (const c of zeroCards) {
    const n = await prisma.bill.count({ where: { cardId: c.id } });
    console.log(`  ${c.bankName} ****0000: ${n} 期`);
  }

  // 5. P2034 冲突邮件数
  const p2034 = errs.filter((e) => (e.error ?? '').includes('P2034') || (e.error ?? '').includes('TransactionWriteConflict'));
  console.log(`\nP2034 写冲突邮件: ${p2034.length} 条（需重同步补齐）`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
