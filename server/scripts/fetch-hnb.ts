// 临时脚本：湖南银行明细实时解析输出（看交易行与卡尾），用完即删
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { fetchBillDetails } from '../src/modules/email/email.service';
import { hnbParser } from '../src/parsers/banks/hnb';
import type { MailContext } from '../src/parsers/types';

async function main() {
  const card = await prisma.card.findFirst({ where: { bankName: '湖南银行' } });
  if (!card) throw new Error('无湖南银行卡');
  const bill = await prisma.bill.findFirst({ where: { cardId: card.id }, orderBy: { period: 'desc' } });
  if (!bill) throw new Error('无账单');

  console.log(`=== 卡 ****${card.cardLast4}，账单 ${bill.period} 金额 ${bill.amount} hasDetails=${bill.hasDetails} ===`);
  const d = await fetchBillDetails(bill.id);
  console.log(`明细 ${d.transactions.length} 条：`);
  for (const t of d.transactions) console.log(`  ${t.date} | ${t.description} | ${t.amount}`);

  // 直接喂解析器看原始 cardLast4 输出
  const parsed = hnbParser.parse({} as MailContext);
  console.log(`空邮件解析: ${parsed.length} 条`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
