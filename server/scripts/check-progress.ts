// 临时脚本：查历史拉取实际进度（MailLog 计数 + 光大未匹配样本），用完即删
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

async function main() {
  const total = await prisma.mailLog.count();
  const matched = await prisma.mailLog.count({ where: { status: 'matched' } });
  const unmatched = await prisma.mailLog.count({ where: { status: 'unmatched' } });
  const error = await prisma.mailLog.count({ where: { status: 'error' } });
  console.log(`MailLog 总数 ${total}：matched=${matched} unmatched=${unmatched} error=${error}`);

  const latest = await prisma.mailLog.findFirst({ orderBy: { uid: 'desc' } });
  console.log(`最新处理 uid=${latest?.uid} subject=${latest?.subject?.slice(0, 40)} date=${latest?.mailDate?.toISOString().slice(0, 10)}`);

  // 光大未匹配样本
  const ceb = await prisma.mailLog.findMany({
    where: { fromAddress: { contains: 'cebbank' }, status: 'unmatched' },
    orderBy: { mailDate: 'asc' },
    take: 10,
  });
  console.log(`\n=== 光大未匹配 ${ceb.length} 条样本 ===`);
  for (const m of ceb) console.log(`  ${m.mailDate?.toISOString().slice(0, 10)} ${m.subject}`);

  // 全部 error 样本（旧模板线索）
  const errs = await prisma.mailLog.findMany({ where: { status: 'error' }, take: 20 });
  console.log(`\n=== error ${errs.length} 条 ===`);
  for (const e of errs) console.log(`  ${e.mailDate?.toISOString().slice(0, 10)} ${e.parserId} ${e.subject?.slice(0, 36)} | ${(e.error ?? '').slice(0, 60)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
