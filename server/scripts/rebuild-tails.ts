// 临时脚本：解析器卡尾修复后数据重整（删 0000 档案 + 全量历史拉取），用完即删
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { startHistorySync, getHistorySyncState } from '../src/modules/email/email.service';

const FIX_BANKS = ['民生银行', '湖南银行', '北京银行', '南京银行', '长沙银行'];

async function main() {
  // 1. 删除 5 个银行的 0000 兜底档案（级联删除其账单与 BillCard，重灌后挂真实卡尾）
  const removed = await prisma.card.deleteMany({
    where: { bankName: { in: FIX_BANKS }, cardLast4: '0000' },
  });
  console.log(`[重整] 删除 0000 档案 ${removed.count} 张`);

  // 2. 清 MailLog + 重置 lastUid，模拟全新初始化
  const logs = await prisma.mailLog.deleteMany({});
  await prisma.emailAccount.updateMany({ data: { lastUid: 0 } });
  console.log(`[重整] 清空 MailLog ${logs.count} 条，lastUid 重置`);

  // 3. 全量历史拉取（邮箱已放开全部邮件范围）
  const accounts = await prisma.emailAccount.findMany({ where: { enabled: true } });
  for (const a of accounts) {
    console.log(`\n=== 历史拉取 ${a.email} ===`);
    const t0 = Date.now();
    await startHistorySync(a.id);
    let lastProcessed = -1;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = getHistorySyncState(a.id);
      if (st.processed !== lastProcessed && (st.processed % 200 === 0 || !st.running)) {
        lastProcessed = st.processed;
        console.log(`  ${st.processed}/${st.total} 匹配${st.matched} 未匹配${st.unmatched} 错误${st.errors}${st.error ? ' ERR:' + st.error : ''}`);
      }
      if (!st.running) {
        console.log(`  完成(${Math.round((Date.now() - t0) / 1000)}s)：匹配${st.matched} 未匹配${st.unmatched} 错误${st.errors}`);
        break;
      }
    }
  }

  // 4. 验证：0000 档案消除、卡尾与账单归属
  const cards = await prisma.card.findMany({ orderBy: { bankName: 'asc' } });
  const zero = cards.filter((c) => c.cardLast4 === '0000');
  console.log(`\n=== 卡片 ${cards.length} 张，残留 0000 档案 ${zero.length} 张 ===`);
  for (const c of zero) console.log(`  残留: ${c.bankName} ****0000（可能该银行账单确实无卡尾可提取）`);

  for (const bank of FIX_BANKS) {
    const bs = cards.filter((c) => c.bankName === bank);
    console.log(`  ${bank}: ${bs.map((c) => c.cardLast4).join(' / ') || '(无卡)'}`);
  }

  const billCount = await prisma.bill.count();
  const detailCount = await prisma.bill.count({ where: { hasDetails: true } });
  const linked = await prisma.billCard.count();
  console.log(`=== 账单 ${billCount} 期（有明细 ${detailCount}），BillCard 关联 ${linked} 条 ===`);
  const periods = await prisma.bill.groupBy({ by: ['period'], _count: true, orderBy: { period: 'asc' } });
  console.log('=== 期次分布 ===');
  for (const p of periods) console.log(`  ${p.period}: ${p._count}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
