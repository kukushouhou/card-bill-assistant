import type { Prisma, PrismaClient } from '../../../generated/prisma/client';
import { prisma } from '../../../lib/prisma';
import { ApiError } from '../../../lib/errors';
import { tryParse, getParserById } from '../../../parsers/registry';
import { acquireEmailAccountLock, openAccountMailReader, type MailBodyResult } from '../../email/email.service';
import type { VersionMigration } from '../migration.types';
import { emptyRepairCounts, REPAIR_PARSERS, repairStatementMail, repaymentLowerBound, type RepairCounts } from './statement-repair';

export const STATEMENT_REPAIR_KEY = 'statement-parser-repair-050-v1';
interface MailItem { mailLogId: number; accountId: number; uid: number; parserId: string; bankName: string; billIds: number[] }
interface BankImpact { bankName: string; billCount: number; mailCount: number }
interface Payload { banks: BankImpact[]; anchor?: string; lowerBound?: string }
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function candidates(db: PrismaClient | Prisma.TransactionClient): Promise<MailItem[]> {
  const logs = await db.mailLog.findMany({ where: { status: 'matched', parserId: { in: REPAIR_PARSERS }, bills: { some: { source: 'email' } } },
    select: { id: true, accountId: true, uid: true, parserId: true, bills: { where: { source: 'email' }, select: { id: true } } },
    orderBy: [{ accountId: 'asc' }, { uid: 'asc' }] });
  return logs.filter((log) => log.bills?.length && REPAIR_PARSERS.includes(log.parserId ?? '')).map((log) => ({ mailLogId: log.id, accountId: log.accountId, uid: log.uid, parserId: log.parserId!,
    bankName: getParserById(log.parserId!)!.bankName, billIds: log.bills.map((bill) => bill.id) }));
}
function bankImpact(items: MailItem[]): BankImpact[] {
  return [...new Set(items.map((item) => item.bankName))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((bankName) => {
    const own = items.filter((item) => item.bankName === bankName);
    return { bankName, billCount: new Set(own.flatMap((item) => item.billIds)).size, mailCount: own.length };
  });
}
function impactText(payload: unknown): string | null {
  const banks = (payload as Payload | null)?.banks;
  if (!Array.isArray(banks) || !banks.length) return null;
  return `需要复核：${banks.map((bank) => `${bank.bankName} ${bank.billCount} 笔现有账单（${bank.mailCount} 封邮件）`).join('；')}。系统将修正金额并补齐原文中的遗漏账单和明细。`;
}

export const repairStatements050Migration: VersionMigration = {
  key: STATEMENT_REPAIR_KEY, targetVersion: '0.5.0', order: 10, mode: 'required',
  title: '历史账单核对与修复',
  description: '核对已有账单的金额、币种及明细，保留手动还款。自动结清状态仅从本次执行日期往前一个月起恢复，包含未来账单。',
  executeLabel: '确认修复',
  describeImpact: ({ payload }) => impactText(payload),
  async inspect(db) {
    const items = await candidates(db);
    return items.length ? { total: items.length, payload: json({ banks: bankImpact(items) }) } : null;
  },
  async prepareTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    const payload = task.payload as unknown as Payload;
    // startedAt 在任务首次执行时写入；失败重试不移动恢复窗口。
    const anchor = new Date(payload.anchor ?? task.startedAt ?? task.approvedAt ?? new Date());
    const lowerBound = payload.lowerBound ?? repaymentLowerBound(anchor).toISOString();
    if (await prisma.upgradeTaskItem.count({ where: { taskId } })) return;
    const items = await candidates(prisma);
    await prisma.$transaction(async (tx) => {
      if (items.length) await tx.upgradeTaskItem.createMany({ data: items.map((item) => ({ taskId,
        itemKey: `mail:${item.accountId}:${item.uid}`, payload: json(item) })), skipDuplicates: true });
      await tx.upgradeTask.update({ where: { id: taskId }, data: { total: items.length,
        payload: json({ banks: bankImpact(items), anchor: anchor.toISOString(), lowerBound }) } });
    });
  },
  async executeTask(taskId) {
    const task = await prisma.upgradeTask.findUniqueOrThrow({ where: { id: taskId } });
    const payload = task.payload as unknown as Payload;
    if (!payload.lowerBound) throw new Error('升级任务缺少固定的还款恢复日期');
    const rows = await prisma.upgradeTaskItem.findMany({ where: { taskId, status: { in: ['pending', 'running', 'failed'] } }, orderBy: { id: 'asc' } });
    for (const accountId of new Set(rows.map((row) => (row.payload as unknown as MailItem).accountId))) {
      const own = rows.filter((row) => (row.payload as unknown as MailItem).accountId === accountId);
      let release: (() => void) | undefined;
      let reader: Awaited<ReturnType<typeof openAccountMailReader>> | undefined;
      let connectionError: unknown;
      try {
        release = acquireEmailAccountLock(accountId);
        try { reader = await retryRead(() => openAccountMailReader(accountId)); } catch (error) { connectionError = error; }
        for (const item of own) {
          const mail = item.payload as unknown as MailItem;
          try {
            let body: MailBodyResult | undefined;
            let unavailable: unknown = connectionError;
            if (reader) { try { body = await retryRead(() => reader!.fetch(mail.uid)); } catch (error) { unavailable = error; } }
            const parsed = body ? tryParse({ ...body, date: new Date(body.date), text: body.text ?? undefined,
              html: body.html ?? undefined, pdfText: body.pdfText ?? undefined, attachText: body.attachText ?? undefined }, mail.parserId) : null;
            if (parsed && (!parsed.matched || !parsed.bills.length)) unavailable = new Error('原文无法完整解析');
            const bills = parsed?.matched && parsed.bills.length ? parsed.bills : null;
            await prisma.$transaction(async (tx) => {
              // 状态与修复写在同一事务，宕机后不会二次翻转金额。
              const current = await tx.upgradeTaskItem.findUniqueOrThrow({ where: { id: item.id } });
              if (current.status === 'succeeded' || current.status === 'unchanged') return;
              const result = await repairStatementMail(tx, { mailLogId: mail.mailLogId, billIds: mail.billIds,
                parserId: mail.parserId, parsed: bills, lowerBound: new Date(payload.lowerBound!) });
              const changed = result.correctedBills + result.addedBills + result.restoredRepayments > 0;
              await tx.upgradeTaskItem.update({ where: { id: item.id }, data: { status: changed ? 'succeeded' : 'unchanged',
                processedAt: new Date(), error: null, payload: json({ ...mail, result,
                  ...(unavailable ? { incompleteReason: '原文不可取得或无法完整读取，未恢复的明细保留原状' } : {}) }) } });
            }, { timeout: 60_000 });
          } catch (error) {
            await prisma.upgradeTaskItem.update({ where: { id: item.id }, data: { status: 'failed', processedAt: new Date(),
              error: error instanceof Error ? error.message.slice(0, 512) : '账单修复失败' } });
          }
          await updateCounts(taskId);
        }
      } catch (error) {
        await prisma.upgradeTaskItem.updateMany({ where: { id: { in: own.map((row) => row.id) }, status: { in: ['pending', 'running', 'failed'] } },
          data: { status: 'failed', error: error instanceof Error ? error.message.slice(0, 512) : '邮箱修复失败' } });
      } finally { await reader?.close().catch(() => undefined); release?.(); }
    }
    const counts = await updateCounts(taskId);
    return { ...counts, error: counts.failed ? '部分账单尚未修复，请重试。已经完成的账单不会重复处理。' : undefined };
  },
};

async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (attempt >= 2 || error instanceof ApiError && error.status === 404) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}
async function updateCounts(taskId: number) {
  const groups = await prisma.upgradeTaskItem.groupBy({ by: ['status'], where: { taskId }, _count: true });
  const get = (status: string) => groups.find((group) => group.status === status)?._count ?? 0;
  const counts = { succeeded: get('succeeded'), unchanged: get('unchanged'), failed: get('failed') };
  await prisma.upgradeTask.update({ where: { id: taskId }, data: { ...counts, processed: counts.succeeded + counts.unchanged + counts.failed } });
  return counts;
}

export async function latestStatementRepairResult() {
  const task = await prisma.upgradeTask.findFirst({ where: { key: STATEMENT_REPAIR_KEY, status: 'completed' }, include: { items: true } });
  if (!task) return null;
  const counts = emptyRepairCounts();
  const incomplete: Array<{ bankName: string; billCount: number; reason: string }> = [];
  for (const item of task.items) {
    const data = item.payload as unknown as MailItem & { result?: RepairCounts; incompleteReason?: string };
    if (data.result) for (const key of Object.keys(counts) as Array<keyof RepairCounts>) counts[key] += data.result[key] ?? 0;
    if (data.incompleteReason) incomplete.push({ bankName: data.bankName, billCount: data.billIds.length, reason: data.incompleteReason });
  }
  const payload = task.payload as unknown as Payload;
  return { version: task.toVersion, finishedAt: task.finishedAt, banks: payload.banks, lowerBound: payload.lowerBound, counts, incomplete };
}
