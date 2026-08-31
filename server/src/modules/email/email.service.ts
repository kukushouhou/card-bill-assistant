import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Attachment } from 'mailparser';
import { extractText, getDocumentProxy } from 'unpdf';
import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { decrypt, encrypt } from '../../lib/crypto';
import { ApiError } from '../../lib/errors';
import { getParserById, matchParser, tryParse } from '../../parsers/registry';
import type { MailContext, RegisteredParser } from '../../parsers/types';
import { applyCurrentCycleTransactions, applyParsedBills } from '../../parsers/pipeline';
import { isDebitOnlyStatement, isImageOnlyMail } from '../../parsers/_util';
import { isBlacklisted } from '../../parsers/blacklist';
import { recomputePrimary } from '../../lib/card-groups';
import { MICROSOFT_YAHEI_GLYPH_MAP } from '../../parsers/assets/microsoft-yahei-glyph-map';

export interface EmailAccountParams {
  email: string;
  imapHost: string;
  imapPort: number;
  tls: boolean;
  authUser: string;
  authPassword: string;
}

const syncingAccounts = new Set<number>();

/** 供历史升级任务复用同一邮箱并发边界；返回释放函数。 */
export function acquireEmailAccountLock(accountId: number): () => void {
  if (syncingAccounts.has(accountId)) throw new ApiError(409, '该邮箱正在同步中，请稍后');
  syncingAccounts.add(accountId);
  return () => syncingAccounts.delete(accountId);
}

function createClient(host: string, port: number, tls: boolean, user: string, pass: string): ImapFlow {
  return new ImapFlow({ host, port, secure: tls, auth: { user, pass }, logger: false });
}

/** 测试 IMAP 连接（不落库） */
export async function testConnection(params: EmailAccountParams): Promise<{ ok: true; mailboxCount: number }> {
  const client = createClient(params.imapHost, params.imapPort, params.tls, params.authUser, params.authPassword);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mb = client.mailbox;
      return { ok: true, mailboxCount: mb ? mb.exists ?? 0 : 0 };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

interface EnvelopeInfo {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  date: Date;
}

async function fetchEnvelopes(client: ImapFlow, uids: number[]): Promise<EnvelopeInfo[]> {
  if (uids.length === 0) return [];
  const messages = await client.fetchAll(uids, { uid: true, envelope: true }, { uid: true });
  return messages
    .filter((m) => m.uid != null && m.envelope)
    .map((m) => {
      // 旧邮件信头日期可能是字符串/非法 Date（Prisma 拒收），统一清洗为有效 Date
      const raw = m.envelope!.date as unknown;
      let date = new Date();
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        date = raw;
      } else if (typeof raw === 'string' || typeof raw === 'number') {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) date = parsed;
      }
      return {
        uid: m.uid as number,
        messageId: m.envelope!.messageId || null,
        from: (m.envelope!.from || []).map((a) => a.address || '').join(', '),
        subject: m.envelope!.subject || '(无标题)',
        date,
      };
    });
}

async function fetchMailContext(client: ImapFlow, uid: number, env: EnvelopeInfo): Promise<MailContext> {
  const msg = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
  const raw = msg ? msg.source : undefined;
  let text: string | undefined;
  let html: string | undefined;
  let pdfText: string | undefined;
  let attachText: string | undefined;
  if (raw) {
    const parsed = await simpleParser(prepareRawForParser(raw, env.from));
    text = parsed.text || undefined;
    html = typeof parsed.html === 'string' ? parsed.html : undefined;
    pdfText = await extractPdfText(parsed.attachments || []);
    attachText = extractAttachmentHtmlText(parsed.attachments || []);
  }
  return { from: env.from, subject: env.subject, date: env.date, text, html, pdfText, attachText };
}

function isCurrentCycleParser(parser: RegisteredParser): boolean {
  return parser.kind === 'current-cycle-transactions';
}

export function shouldFetchCurrentCycleMail(input: {
  history: boolean;
  lastUid: number;
  statementDate: Date | null;
  mailDate: Date;
}): boolean {
  if (input.history) return false;
  if (input.statementDate) return input.mailDate > input.statementDate;
  // 首次回看没有正式账期边界时不猜历史；同步游标建立后只处理真正新增邮件。
  return input.lastUid > 0;
}

async function latestBankStatementDate(bankName: string): Promise<Date | null> {
  const latest = await prisma.bill.findFirst({
    where: { card: { bankName }, source: 'email' },
    orderBy: { statementDate: 'desc' },
    select: { statementDate: true },
  });
  return latest?.statementDate ?? null;
}

async function previewLatestCmbStatementDate(
  client: ImapFlow,
  envelopes: EnvelopeInfo[],
  cache: Map<number, MailContext>,
  current: Date | null,
): Promise<Date | null> {
  let latest = current;
  const candidates = [...envelopes]
    .filter((env) => {
      const match = matchParser(env.from, env.subject);
      return match?.parser.bankName === '招商银行' && !isCurrentCycleParser(match.parser);
    })
    .sort((a, b) => b.uid - a.uid);
  for (const env of candidates) {
    if (latest && env.date <= latest) break;
    const mail = cache.get(env.uid) ?? await fetchMailContext(client, env.uid, env);
    cache.set(env.uid, mail);
    const result = tryParse(mail);
    if (!result.matched || result.bills.length === 0) continue;
    const statementDate = result.bills.reduce<Date | null>(
      (max, bill) => (!max || bill.statementDate > max ? bill.statementDate : max),
      null,
    );
    if (statementDate && (!latest || statementDate > latest)) latest = statementDate;
    break;
  }
  return latest;
}

async function reprocessCurrentCycleDailyLogs(
  client: ImapFlow,
  accountId: number,
  statementDate: Date | null,
): Promise<{ matchedUids: number[]; errors: number }> {
  if (!statementDate) return { matchedUids: [], errors: 0 };
  const logs = await prisma.mailLog.findMany({
    where: {
      accountId,
      status: 'unmatched',
      subject: '每日信用管家',
      mailDate: { gt: statementDate },
    },
    orderBy: { uid: 'asc' },
  });
  const matchedUids: number[] = [];
  let errors = 0;
  for (const log of logs) {
    const env: EnvelopeInfo = {
      uid: log.uid,
      messageId: log.messageId,
      from: log.fromAddress,
      subject: log.subject,
      date: log.mailDate,
    };
    const match = matchParser(env.from, env.subject);
    if (!match || !isCurrentCycleParser(match.parser)) continue;
    try {
      const mail = await fetchMailContext(client, env.uid, env);
      const result = tryParse(mail);
      if (!result.matched || result.currentCycleTransactions.length === 0) {
        errors++;
        await prisma.mailLog.update({
          where: { id: log.id },
          data: {
            status: 'error',
            parserId: match.parser.id,
            error: result.matched ? result.error ?? '解析返回空' : result.reason,
          },
        });
        continue;
      }
      const created = await applyCurrentCycleTransactions(log.id, result.currentCycleTransactions, statementDate);
      if (created === 0) continue;
      await prisma.mailLog.update({
        where: { id: log.id },
        data: { status: 'matched', parserId: result.parserId, error: null },
      });
      matchedUids.push(log.uid);
    } catch (error) {
      errors++;
      await prisma.mailLog.update({
        where: { id: log.id },
        data: {
          status: 'error',
          parserId: match.parser.id,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        },
      });
    }
  }
  return { matchedUids, errors };
}

/**
 * 农行旧账单把 GBK/GB18030 正文声明为 charset=""，mailparser 会按 UTF-8 解码。
 * 仅修正已识别农行发件人与空声明组合，原始邮件正文仍不落库。
 */
export function prepareRawForParser(raw: Buffer, from: string): Buffer {
  if (!/@creditcard\.abchina\.com(?:\.cn)?\b/i.test(from)) return raw;
  const binary = raw.toString('latin1');
  if (!/charset\s*=\s*(?:""|'')/i.test(binary)) return raw;
  return Buffer.from(binary.replace(/charset\s*=\s*(?:""|'')/gi, 'charset=gb18030'), 'latin1');
}

/** 提取 PDF 附件的文本（账单正文在附件中的银行，如中国银行合并账单） */
export async function extractPdfText(attachments: Attachment[]): Promise<string | undefined> {
  const MAX_BYTES = 5 * 1024 * 1024;
  const chunks: string[] = [];
  for (const a of attachments) {
    const isPdf = a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || '');
    const content = a.content as Buffer | undefined;
    if (!isPdf || !content || content.length > MAX_BYTES) continue;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(content));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text];
      const repaired: string[] = [];
      for (let pageNumber = 1; pageNumber <= pages.length; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        repaired.push(await repairMicrosoftYaHeiText(page, pages[pageNumber - 1] ?? ''));
      }
      const trimmed = repaired.join('\n').trim();
      if (trimmed) chunks.push(trimmed.slice(0, 200_000));
    } catch (err) {
      console.warn(`[email] PDF 附件提取失败 ${a.filename}:`, err instanceof Error ? err.message : err);
    }
  }
  return chunks.length ? chunks.join('\n') : undefined;
}

/** 仅修复 Microsoft YaHei 字体中 PDF.js 仍原样返回 CID 的字符。 */
async function repairMicrosoftYaHeiText(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>['getPage']>>,
  text: string,
): Promise<string> {
  const operators = await page.getOperatorList();
  const replacements = new Map<string, string>();
  let microsoftYaHei = false;
  for (let index = 0; index < operators.fnArray.length; index++) {
    const args = operators.argsArray[index] as unknown[] | null;
    if (operators.fnArray[index] === 37 && args?.[0]) {
      const font = page.commonObjs.get(String(args[0])) as { name?: string } | undefined;
      microsoftYaHei = /MicrosoftYaHei/i.test(font?.name ?? '');
      continue;
    }
    if (!microsoftYaHei || operators.fnArray[index] !== 44 || !Array.isArray(args?.[0])) continue;
    for (const glyph of args[0] as Array<{ unicode?: string; originalCharCode?: number }>) {
      if (!glyph.unicode || glyph.originalCharCode == null) continue;
      if (glyph.unicode.codePointAt(0) !== glyph.originalCharCode) continue;
      const repaired = MICROSOFT_YAHEI_GLYPH_MAP[glyph.originalCharCode];
      if (repaired) replacements.set(glyph.unicode, repaired);
    }
  }
  if (replacements.size === 0) return text;
  return Array.from(text, (character) => replacements.get(character) ?? character).join('');
}

/** 提取 HTML 附件的文本（账单正文在 HTML 附件中的银行，如工商银行 2018-2019 对账单，GBK 编码） */
export function extractAttachmentHtmlText(attachments: Attachment[]): string | undefined {
  const MAX_BYTES = 5 * 1024 * 1024;
  const chunks: string[] = [];
  for (const a of attachments) {
    const isHtml = a.contentType === 'text/html' || /\.html?$/i.test(a.filename || '');
    const content = a.content as Buffer | undefined;
    if (!isHtml || !content || content.length > MAX_BYTES) continue;
    try {
      // 老银行邮件 HTML 附件多为 GBK/GB18030 编码；Node 内置 full-icu 的 TextDecoder 支持
      let decoded: string;
      try {
        decoded = new TextDecoder('gb18030').decode(content);
      } catch {
        decoded = content.toString('utf8');
      }
      const trimmed = decoded.trim();
      if (trimmed) chunks.push(trimmed.slice(0, 500_000));
    } catch (err) {
      console.warn(`[email] HTML 附件提取失败 ${a.filename}:`, err instanceof Error ? err.message : err);
    }
  }
  return chunks.length ? chunks.join('\n') : undefined;
}

/** 手动/定时同步一个邮箱账户 */
export async function syncAccount(accountId: number): Promise<{
  synced: number;
  matched: number;
  unmatched: number;
  image: number;
  errors: number;
}> {
  if (syncingAccounts.has(accountId)) throw new ApiError(409, '该邮箱正在同步中，请稍后');
  syncingAccounts.add(accountId);
  try {
    const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new ApiError(404, '邮箱账户不存在');
    if (!account.enabled) throw new ApiError(400, '该邮箱账户已停用');

    const password = decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc));
    const client = createClient(account.imapHost, account.imapPort, account.tls, account.authUser, password);
    const summary = { synced: 0, matched: 0, unmatched: 0, image: 0, errors: 0 };

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // 增量：uid > lastUid；首次：近 N 天
      const searched: number[] | false =
        account.lastUid > 0
          ? await client.search({ uid: `${account.lastUid + 1}:*` }, { uid: true })
          : await client.search({ since: new Date(Date.now() - account.syncDaysBack * 86_400_000) }, { uid: true });
      const uids = (searched || []).filter((u) => u > account.lastUid).sort((a, b) => a - b);

      const envelopes = await fetchEnvelopes(client, uids);
      const mailCache = new Map<number, MailContext>();
      let currentCmbStatementDate = await latestBankStatementDate('招商银行');
      currentCmbStatementDate = await previewLatestCmbStatementDate(
        client,
        envelopes,
        mailCache,
        currentCmbStatementDate,
      );
      let newLastUid = account.lastUid;

      for (const env of envelopes) {
        summary.synced++;
        newLastUid = Math.max(newLastUid, env.uid);
        try {
          const existed = await prisma.mailLog.findUnique({
            where: { accountId_uid: { accountId, uid: env.uid } },
          });
          if (existed) continue;

          // 营销黑名单：记未匹配，不拉正文、不解析、不计错误
          if (isBlacklisted(env.from)) {
            summary.unmatched++;
            await prisma.mailLog.create({
              data: {
                accountId,
                uid: env.uid,
                messageId: env.messageId?.slice(0, 255),
                fromAddress: env.from.slice(0, 255),
                subject: env.subject.slice(0, 512),
                mailDate: env.date,
                status: 'unmatched',
              },
            });
            continue;
          }

          const match = matchParser(env.from, env.subject);
          if (!match) {
            summary.unmatched++;
            await prisma.mailLog.create({
              data: {
                accountId,
                uid: env.uid,
                messageId: env.messageId?.slice(0, 255),
                fromAddress: env.from.slice(0, 255),
                subject: env.subject.slice(0, 512),
                mailDate: env.date,
                status: 'unmatched',
              },
            });
            continue;
          }

          // 日度邮件只处理当前账期。首次回看且还没有正式账单时不猜历史边界。
          if (isCurrentCycleParser(match.parser)) {
            if (!shouldFetchCurrentCycleMail({
              history: false,
              lastUid: account.lastUid,
              statementDate: currentCmbStatementDate,
              mailDate: env.date,
            })) {
              summary.unmatched++;
              await prisma.mailLog.create({
                data: {
                  accountId,
                  uid: env.uid,
                  messageId: env.messageId?.slice(0, 255),
                  fromAddress: env.from.slice(0, 255),
                  subject: env.subject.slice(0, 512),
                  mailDate: env.date,
                  status: 'unmatched',
                },
              });
              continue;
            }
          }

          // 命中解析器才拉取完整正文（不标记已读）；自动模式下 tryParse 内部按优先级降级尝试旧版解析器
          const mail = mailCache.get(env.uid) ?? await fetchMailContext(client, env.uid, env);
          const result = tryParse(mail);
          const hasParsedContent = result.matched
            && (result.bills.length > 0 || result.currentCycleTransactions.length > 0);
          if (hasParsedContent && result.matched) {
            // 先建 MailLog 再落账单：Bill.mailLogId 需关联源邮件（查看明细时实时拉取）
            const mailLog = await prisma.mailLog.create({
              data: {
                accountId,
                uid: env.uid,
                messageId: env.messageId?.slice(0, 255),
                fromAddress: env.from.slice(0, 255),
                subject: env.subject.slice(0, 512),
                mailDate: env.date,
                status: 'matched',
                parserId: result.parserId,
              },
            });
            if (result.bills.length > 0) {
              await applyParsedBills(mailLog.id, result.parserId, result.bills);
              const latest = result.bills.reduce<Date | null>(
                (max, bill) => (!max || bill.statementDate > max ? bill.statementDate : max),
                currentCmbStatementDate,
              );
              if (result.bills.some((bill) => bill.bankName === '招商银行')) currentCmbStatementDate = latest;
              summary.matched++;
            } else {
              const created = await applyCurrentCycleTransactions(
                mailLog.id,
                result.currentCycleTransactions,
                currentCmbStatementDate,
              );
              if (created > 0) {
                summary.matched++;
              } else {
                summary.unmatched++;
                await prisma.mailLog.update({
                  where: { id: mailLog.id },
                  data: { status: 'unmatched', parserId: null },
                });
              }
            }
          } else {
            // 图片账单：正文/附件均无文本、金额全在图片里（如招行 2016-2021），不算错误
            if (isImageOnlyMail(mail)) {
              summary.image++;
              await prisma.mailLog.create({
                data: {
                  accountId,
                  uid: env.uid,
                  messageId: env.messageId?.slice(0, 255),
                  fromAddress: env.from.slice(0, 255),
                  subject: env.subject.slice(0, 512),
                  mailDate: env.date,
                  status: 'image',
                  parserId: result.matched ? result.parserId : match.parser.id,
                },
              });
              continue;
            }
            // 借记卡综合对账单（如工行 2018-2019 个人综合对账单）：无信用卡账单可产出，记未匹配、不写 parserId、不计错误
            if (isDebitOnlyStatement(mail)) {
              summary.unmatched++;
              await prisma.mailLog.create({
                data: {
                  accountId,
                  uid: env.uid,
                  messageId: env.messageId?.slice(0, 255),
                  fromAddress: env.from.slice(0, 255),
                  subject: env.subject.slice(0, 512),
                  mailDate: env.date,
                  status: 'unmatched',
                },
              });
              continue;
            }
            summary.errors++;
            const error = result.matched ? result.error || '解析返回空' : '解析器未命中';
            await prisma.mailLog.create({
              data: {
                accountId,
                uid: env.uid,
                messageId: env.messageId?.slice(0, 255),
                fromAddress: env.from.slice(0, 255),
                subject: env.subject.slice(0, 512),
                mailDate: env.date,
                status: 'error',
                parserId: result.matched ? result.parserId : match.parser.id,
                error: error.slice(0, 512),
              },
            });
          }
        } catch (err) {
          summary.errors++;
          console.error(`[email] 处理邮件失败 uid=${env.uid}:`, err);
        }
      }

      // 升级后已有的本账期日度 MailLog 仍是 unmatched，定向补处理，不触碰往期邮件。
      const repaired = await reprocessCurrentCycleDailyLogs(client, accountId, currentCmbStatementDate);
      summary.matched += repaired.matchedUids.length;
      summary.errors += repaired.errors;

      await prisma.emailAccount.update({
        where: { id: accountId },
        data: { lastUid: newLastUid, lastSyncAt: new Date() },
      });
    } finally {
      lock.release();
      await client.logout().catch(() => client.close());
    }
    // 解析入库后按套卡归组标记优先显示卡
    if (summary.matched > 0) await recomputePrimary();
    return summary;
  } finally {
    syncingAccounts.delete(accountId);
  }
}

export async function syncAllEnabledAccounts(): Promise<void> {
  const accounts = await prisma.emailAccount.findMany({ where: { enabled: true } });
  for (const account of accounts) {
    try {
      const s = await syncAccount(account.id);
      console.log(
        `[email] 同步完成 ${account.email}: 新增${s.synced} 匹配${s.matched} 未匹配${s.unmatched} 图片${s.image} 错误${s.errors}`,
      );
    } catch (err) {
      console.error(`[email] 同步失败 ${account.email}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** 解析器调试：从绑定邮箱实时拉取最近 N 封（或近 N 天）邮件干跑（不落库） */
export async function dryRunParse(accountId: number, limit = 20, parserId?: string, sinceDays?: number) {
  const maxLimit = sinceDays ? 1000 : 100;
  const n = Math.min(Math.max(1, limit), maxLimit);
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new ApiError(404, '邮箱账户不存在');

  const password = decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc));
  const client = createClient(account.imapHost, account.imapPort, account.tls, account.authUser, password);
  const results: Array<{
    uid: number;
    from: string;
    subject: string;
    date: string;
    parserId: string | null;
    parsed: boolean;
    bills?: unknown;
    currentCycleTransactionCount?: number;
    error?: string;
  }> = [];

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    let uids: number[];
    if (sinceDays) {
      const searched =
        (await client.search({ since: new Date(Date.now() - sinceDays * 86_400_000) }, { uid: true })) || [];
      uids = searched.sort((a, b) => a - b).slice(-n);
    } else {
      const all = (await client.search({ all: true }, { uid: true })) || [];
      uids = all.slice(-n);
    }
    const envelopes = await fetchEnvelopes(client, uids);
    for (const env of envelopes) {
      try {
        // 白名单制：未命中解析器且未强制指定解析器时不拉取正文
        if (!parserId && !matchParser(env.from, env.subject)) {
          results.push({
            uid: env.uid,
            from: env.from,
            subject: env.subject,
            date: env.date.toISOString(),
            parserId: null,
            parsed: false,
            error: '无解析器命中（发件人/标题均不匹配）',
          });
          continue;
        }
        if (parserId && !getParserById(parserId)) {
          results.push({
            uid: env.uid,
            from: env.from,
            subject: env.subject,
            date: env.date.toISOString(),
            parserId: null,
            parsed: false,
            error: `解析器 ${parserId} 不存在`,
          });
          continue;
        }
        const mail = await fetchMailContext(client, env.uid, env);
        const result = tryParse(mail, parserId);
        const parsed = result.matched
          && (result.bills.length > 0 || result.currentCycleTransactions.length > 0);
        results.push({
          uid: env.uid,
          from: env.from,
          subject: env.subject,
          date: env.date.toISOString(),
          parserId: result.matched ? result.parserId : null,
          parsed,
          bills: result.matched ? result.bills : undefined,
          currentCycleTransactionCount: result.matched
            ? result.currentCycleTransactions.reduce((sum, batch) => sum + batch.transactions.length, 0)
            : undefined,
          error: result.matched ? result.error || (parsed ? undefined : '解析返回空') : result.reason,
        });
      } catch (err) {
        results.push({
          uid: env.uid,
          from: env.from,
          subject: env.subject,
          date: env.date.toISOString(),
          parserId: null,
          parsed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
  }
  return { total: results.length, results: results.reverse() };
}

export interface MailBodyResult {
  uid: number;
  from: string;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  pdfText: string | null;
  attachText: string | null;
  attachments: Array<{ filename: string; size: number }>;
}

async function fetchMailBodyFromClient(client: ImapFlow, uid: number): Promise<MailBodyResult> {
  const msg = await client.fetchOne(uid, { uid: true, envelope: true, source: true }, { uid: true });
  if (!msg || !msg.envelope) throw new ApiError(404, '邮件不存在');
  if (!msg.source) throw new ApiError(404, '邮件原文为空');
  const fromAddress = (msg.envelope.from || []).map((a) => a.address || '').join(', ');
  const parsed = await simpleParser(prepareRawForParser(msg.source, fromAddress));
  const pdfText = await extractPdfText(parsed.attachments || []);
  const attachText = extractAttachmentHtmlText(parsed.attachments || []);
  return {
    uid,
    from: (msg.envelope.from || []).map((a) => `${a.name || ''} <${a.address || ''}>`.trim()).join(', '),
    subject: msg.envelope.subject || '(无标题)',
    date: (msg.envelope.date || new Date()).toISOString(),
    text: parsed.text || null,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    pdfText: pdfText ?? null,
    attachText: attachText ?? null,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || '(未命名附件)',
      size: (a.content as Buffer | undefined)?.length ?? 0,
    })),
  };
}

/** 历史任务按账户复用一次 IMAP 连接，仍逐封只在内存中读取原文。 */
export async function openAccountMailReader(accountId: number): Promise<{
  fetch: (uid: number) => Promise<MailBodyResult>;
  close: () => Promise<void>;
}> {
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new ApiError(404, '邮箱账户不存在');

  const password = decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc));
  const client = createClient(account.imapHost, account.imapPort, account.tls, account.authUser, password);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let closed = false;
    return {
      fetch: (uid) => fetchMailBodyFromClient(client, uid),
      close: async () => {
        if (closed) return;
        closed = true;
        lock.release();
        await client.logout().catch(() => client.close());
      },
    };
  } catch (error) {
    await client.logout().catch(() => client.close());
    throw error;
  }
}

/** 实时读取单封邮件正文（不落库），供解析器调试 */
export async function fetchMailBody(accountId: number, uid: number): Promise<MailBodyResult> {
  const reader = await openAccountMailReader(accountId);
  try {
    return await reader.fetch(uid);
  } finally {
    await reader.close();
  }
}

/** 重新同步：清除该账户同步日志并重置 lastUid，重新拉取近 N 天邮件（账单 upsert 幂等，无数据风险） */
export async function resyncAccount(accountId: number) {
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new ApiError(404, '邮箱账户不存在');
  await prisma.mailLog.deleteMany({ where: { accountId } });
  await prisma.emailAccount.update({ where: { id: accountId }, data: { lastUid: 0 } });
  return syncAccount(accountId);
}

// ===== 历史拉取：全量拉取邮箱全部历史邮件（不限时间），后台任务 + 进度轮询 =====

export interface HistorySyncState {
  running: boolean;
  /** 待处理邮件总数 */
  total: number;
  processed: number;
  matched: number;
  unmatched: number;
  /** 图片账单数（正文无文本、金额在图片里） */
  image: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const historySyncStates = new Map<number, HistorySyncState>();

function initialHistoryState(): HistorySyncState {
  return {
    running: false,
    total: 0,
    processed: 0,
    matched: 0,
    unmatched: 0,
    image: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export function getHistorySyncState(accountId: number): HistorySyncState {
  return { ...(historySyncStates.get(accountId) ?? initialHistoryState()) };
}

/** 启动历史拉取后台任务（立即返回，前端轮询进度） */
export async function startHistorySync(accountId: number): Promise<HistorySyncState> {
  if (syncingAccounts.has(accountId)) throw new ApiError(409, '该邮箱正在同步中，请稍后');
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new ApiError(404, '邮箱账户不存在');
  if (!account.enabled) throw new ApiError(400, '该邮箱账户已停用');
  if ((historySyncStates.get(accountId)?.running) === true) {
    throw new ApiError(409, '历史拉取正在进行中');
  }

  syncingAccounts.add(accountId);
  const state: HistorySyncState = { ...initialHistoryState(), running: true, startedAt: new Date().toISOString() };
  historySyncStates.set(accountId, state);

  void runHistorySync(accountId)
    .catch((err) => {
      state.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      syncingAccounts.delete(accountId);
    });

  return { ...state };
}

/** 历史拉取主体：全量 UID → 过滤已处理 → 分批 envelope → 逐封走白名单解析流程 */
async function runHistorySync(accountId: number): Promise<void> {
  const state = historySyncStates.get(accountId);
  if (!state) throw new Error('历史拉取状态丢失');
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new ApiError(404, '邮箱账户不存在');

  const password = decrypt(config.encryptionKey, Buffer.from(account.authPasswordEnc));
  const client = createClient(account.imapHost, account.imapPort, account.tls, account.authUser, password);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const allUids = ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b);
    // 已有 MailLog 记录的邮件跳过（与增量同步去重口径一致）
    const existing = await prisma.mailLog.findMany({ where: { accountId }, select: { uid: true } });
    const seen = new Set(existing.map((m) => m.uid));
    const uids = allUids.filter((u) => !seen.has(u));
    state.total = uids.length;

    let newLastUid = account.lastUid;
    const dailyUidsThisRun = new Set<number>();
    const BATCH = 200;
    for (let i = 0; i < uids.length; i += BATCH) {
      const envelopes = await fetchEnvelopes(client, uids.slice(i, i + BATCH));
      // 未命中白名单/黑名单的邮件攒批写入（大邮箱全量拉取时避免逐条 insert）
      const skippedRows: Array<{
        accountId: number;
        uid: number;
        messageId: string | null;
        fromAddress: string;
        subject: string;
        mailDate: Date;
        status: string;
      }> = [];
      for (const env of envelopes) {
        state.processed++;
        newLastUid = Math.max(newLastUid, env.uid);
        try {
          // 营销黑名单：记未匹配，不拉正文、不解析、不计错误
          if (isBlacklisted(env.from)) {
            state.unmatched++;
            skippedRows.push({
              accountId,
              uid: env.uid,
              messageId: env.messageId?.slice(0, 255) ?? null,
              fromAddress: env.from.slice(0, 255),
              subject: env.subject.slice(0, 512),
              mailDate: env.date,
              status: 'unmatched',
            });
            continue;
          }

          const match = matchParser(env.from, env.subject);
          if (!match) {
            state.unmatched++;
            skippedRows.push({
              accountId,
              uid: env.uid,
              messageId: env.messageId?.slice(0, 255) ?? null,
              fromAddress: env.from.slice(0, 255),
              subject: env.subject.slice(0, 512),
              mailDate: env.date,
              status: 'unmatched',
            });
            continue;
          }

          // 历史拉取不读取日度邮件正文；正式账单全部落库后只补当前账期。
          if (isCurrentCycleParser(match.parser) && !shouldFetchCurrentCycleMail({
            history: true,
            lastUid: account.lastUid,
            statementDate: null,
            mailDate: env.date,
          })) {
            state.unmatched++;
            dailyUidsThisRun.add(env.uid);
            skippedRows.push({
              accountId,
              uid: env.uid,
              messageId: env.messageId?.slice(0, 255) ?? null,
              fromAddress: env.from.slice(0, 255),
              subject: env.subject.slice(0, 512),
              mailDate: env.date,
              status: 'unmatched',
            });
            continue;
          }

          const mail = await fetchMailContext(client, env.uid, env);
          const result = tryParse(mail);
          if (result.matched && result.bills.length > 0) {
            const mailLog = await prisma.mailLog.create({
              data: {
                accountId,
                uid: env.uid,
                messageId: env.messageId?.slice(0, 255),
                fromAddress: env.from.slice(0, 255),
                subject: env.subject.slice(0, 512),
                mailDate: env.date,
                status: 'matched',
                parserId: result.parserId,
              },
            });
            await applyParsedBills(mailLog.id, result.parserId, result.bills);
            state.matched++;
          } else {
            // 图片账单：正文/附件均无文本、金额全在图片里（如招行 2016-2021），不算错误
            if (isImageOnlyMail(mail)) {
              state.image++;
              await prisma.mailLog.create({
                data: {
                  accountId,
                  uid: env.uid,
                  messageId: env.messageId?.slice(0, 255),
                  fromAddress: env.from.slice(0, 255),
                  subject: env.subject.slice(0, 512),
                  mailDate: env.date,
                  status: 'image',
                  parserId: result.matched ? result.parserId : match.parser.id,
                },
              });
              continue;
            }
            // 借记卡综合对账单（如工行 2018-2019 个人综合对账单）：无信用卡账单可产出，记未匹配、不写 parserId、不计错误
            if (isDebitOnlyStatement(mail)) {
              state.unmatched++;
              await prisma.mailLog.create({
                data: {
                  accountId,
                  uid: env.uid,
                  messageId: env.messageId?.slice(0, 255),
                  fromAddress: env.from.slice(0, 255),
                  subject: env.subject.slice(0, 512),
                  mailDate: env.date,
                  status: 'unmatched',
                },
              });
              continue;
            }
            state.errors++;
            const error = result.matched ? result.error || '解析返回空' : '解析器未命中';
            await prisma.mailLog.create({
              data: {
                accountId,
                uid: env.uid,
                messageId: env.messageId?.slice(0, 255),
                fromAddress: env.from.slice(0, 255),
                subject: env.subject.slice(0, 512),
                mailDate: env.date,
                status: 'error',
                parserId: result.matched ? result.parserId : match.parser.id,
                error: error.slice(0, 512),
              },
            });
          }
        } catch (err) {
          state.errors++;
          console.error(`[email] 历史拉取处理邮件失败 uid=${env.uid}:`, err);
        }
      }
      if (skippedRows.length > 0) {
        await prisma.mailLog.createMany({ data: skippedRows });
      }
    }

    const currentCmbStatementDate = await latestBankStatementDate('招商银行');
    const repaired = await reprocessCurrentCycleDailyLogs(client, accountId, currentCmbStatementDate);
    state.matched += repaired.matchedUids.length;
    state.errors += repaired.errors;
    state.unmatched = Math.max(
      0,
      state.unmatched - repaired.matchedUids.filter((uid) => dailyUidsThisRun.has(uid)).length,
    );

    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { lastUid: newLastUid, lastSyncAt: new Date() },
    });
    // 全量重灌后按套卡归组标记优先显示卡
    if (state.matched > 0) await recomputePrimary();
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
  }
}

/** 供路由层复用的加密入口 */
export function encryptAuthPassword(plain: string): Uint8Array<ArrayBuffer> {
  return encrypt(config.encryptionKey, plain);
}
