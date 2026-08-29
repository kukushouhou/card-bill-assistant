/**
 * 年费收取日存量回填：直接使用已持久化账单明细，按明细 cardId 回填对应卡片。
 * 默认执行更新；加 --dry-run 仅输出候选和差异。
 * 用法：cd server && npx tsx scripts/backfill-annual-fee.ts [--dry-run]
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { ymd } from '../src/lib/dates';
import { isAnnualFeeDateEvidence } from '../src/parsers/_util';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const rows = await prisma.billTransaction.findMany({
    where: {
      billId: { not: null },
      description: { contains: '年费' },
    },
    select: {
      id: true,
      cardId: true,
      transactionDate: true,
      description: true,
      amount: true,
      card: {
        select: {
          id: true,
          bankName: true,
          cardLast4: true,
          annualFeeDate: true,
          annualFeeDateManual: true,
        },
      },
    },
  });

  const latestByCard = new Map<number, { date: Date; card: NonNullable<(typeof rows)[number]['card']> }>();
  let evidenceCount = 0;
  let missingTarget = 0;
  for (const row of rows) {
    if (!isAnnualFeeDateEvidence({ amount: Number(row.amount), description: row.description })) continue;
    evidenceCount++;
    if (row.cardId == null || row.transactionDate == null || row.card == null) {
      missingTarget++;
      continue;
    }
    const current = latestByCard.get(row.cardId);
    if (!current || row.transactionDate > current.date) {
      latestByCard.set(row.cardId, { date: row.transactionDate, card: row.card });
    }
  }

  let skippedManual = 0;
  let skippedOlder = 0;
  const changes: Array<{ cardId: number; bankName: string; cardLast4: string; from: Date | null; to: Date }> = [];
  for (const [cardId, candidate] of latestByCard) {
    const current = candidate.card.annualFeeDate;
    if (candidate.card.annualFeeDateManual) {
      skippedManual++;
      continue;
    }
    if (current && ymd(current).slice(5) === ymd(candidate.date).slice(5)) continue;
    if (current && candidate.date <= current) {
      skippedOlder++;
      continue;
    }
    changes.push({
      cardId,
      bankName: candidate.card.bankName,
      cardLast4: candidate.card.cardLast4,
      from: current,
      to: candidate.date,
    });
  }

  console.log(
    `=== 年费日回填预检：含年费明细 ${rows.length}，有效证据 ${evidenceCount}，涉及卡片 ${latestByCard.size} ===`,
  );
  console.log(`缺少卡片或日期 ${missingTarget}，手动设置跳过 ${skippedManual}，旧证据跳过 ${skippedOlder}，待更新 ${changes.length}`);
  for (const change of changes) {
    console.log(
      `${change.bankName}(${change.cardLast4}) ${change.from ? ymd(change.from) : '未设置'} → ${ymd(change.to)}`,
    );
  }

  if (dryRun) {
    console.log('=== dry-run 完成，未写入数据库 ===');
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const change of changes) {
      await tx.card.update({ where: { id: change.cardId }, data: { annualFeeDate: change.to } });
    }
  });

  const updatedCards = changes.length > 0
    ? await prisma.card.findMany({
        where: { id: { in: changes.map((change) => change.cardId) } },
        select: { id: true, annualFeeDate: true },
      })
    : [];
  const updatedById = new Map(updatedCards.map((card) => [card.id, card.annualFeeDate]));
  const failed = changes.filter((change) => {
    const actual = updatedById.get(change.cardId);
    return !actual || ymd(actual) !== ymd(change.to);
  });
  if (failed.length > 0) {
    throw new Error(`年费日回填后校验失败：${failed.map((change) => change.cardId).join(', ')}`);
  }
  console.log(`=== 完成：回填 ${changes.length}，校验失败 0 ===`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
