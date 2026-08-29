// 临时验证脚本：回灌后检查卡片/账单落库情况（用完即删）
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

async function main() {
  // 清理通用称呼误存的持卡人（如中行邮件"尊敬的客户您好"）
  const cleaned = await prisma.card.updateMany({ where: { holderName: { in: ['客户您好', '客户', '您好'] } }, data: { holderName: null } });
  console.log('=== 清理误存持卡人:', cleaned.count);

  const a = await prisma.emailAccount.findFirst();
  console.log('=== 账户配置 syncDaysBack=', a?.syncDaysBack, 'enabled=', a?.enabled);
  const first = await prisma.mailLog.findFirst({ orderBy: { uid: 'asc' } });
  console.log('最早同步邮件:', first?.mailDate?.toISOString(), first?.subject?.slice(0, 30));

  const cards = await prisma.card.findMany({ orderBy: { bankName: 'asc' } });
  console.log(`=== 卡片档案（${cards.length}）===`);
  for (const c of cards) {
    const bills = await prisma.bill.count({ where: { cardId: c.id } });
    const rule = c.dueRule === 'offset' ? `+${c.dueOffsetDays}天` : `每月${c.dueDay}日`;
    console.log(`${c.bankName} ****${c.cardLast4} 出账日${c.statementDay} ${c.dueRule}${rule} 账单数${bills} 持卡人${c.holderName ?? '-'} 来源${c.source}`);
  }
  const total = await prisma.bill.count();
  console.log('=== 账单总数:', total);

  const errs = await prisma.mailLog.findMany({ where: { status: 'error' } });
  console.log('=== 解析错误邮件 ===');
  for (const e of errs) console.log(e.uid, e.subject, (e.error || '').slice(0, 120));

  const periods = await prisma.bill.groupBy({ by: ['period'], _count: true, orderBy: { period: 'asc' } });
  console.log('=== 按期次分布 ===');
  for (const p of periods) console.log(p.period, p._count);

  const matched = await prisma.mailLog.findMany({ where: { status: 'matched' }, orderBy: { uid: 'asc' } });
  console.log(`=== 命中邮件明细（${matched.length}）===`);
  for (const m of matched) console.log(m.uid, m.subject.slice(0, 40), m.parserId);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
