import type {
  BankParser,
  MailContext,
  ParsedBill,
  ParsedCurrentCycleTransactions,
  ParserMatchResult,
  RegisteredParser,
} from './types';
import { cmbdaily2026Parser } from './banks/cmbdaily-2026';
import { cmb2026Parser } from './banks/cmb-2026';
import { cmb2020Parser } from './banks/cmb-2020';
import { cmb2016Parser } from './banks/cmb-2016';
import { icbc2026Parser } from './banks/icbc-2026';
import { abc2026Parser } from './banks/abc-2026';
import { abc2019Parser } from './banks/abc-2019';
import { boc2026Parser } from './banks/boc-2026';
import { boc2020Parser } from './banks/boc-2020';
import { cib2026Parser } from './banks/cib-2026';
import { cgb2026Parser } from './banks/cgb-2026';
import { psbc2026Parser } from './banks/psbc-2026';
import { psbc2022Parser } from './banks/psbc-2022';
import { cmbc2026Parser } from './banks/cmbc-2026';
import { hnb2026Parser } from './banks/hnb-2026';
import { bocom2026Parser } from './banks/bocom-2026';
import { bocom2019Parser } from './banks/bocom-2019';
import { njcb2026Parser } from './banks/njcb-2026';
import { njcb2023Parser } from './banks/njcb-2023';
import { ceb2026Parser } from './banks/ceb-2026';
import { ceb2019Parser } from './banks/ceb-2019';
import { ceb2017Parser } from './banks/ceb-2017';
import { ceb2016Parser } from './banks/ceb-2016';
import { citic2026Parser } from './banks/citic-2026';
import { citic2023Parser } from './banks/citic-2023';
import { citic2020Parser } from './banks/citic-2020';
import { ccb2026Parser } from './banks/ccb-2026';
import { hnnxs2026Parser } from './banks/hnnxs-2026';
import { pab2026Parser } from './banks/pab-2026';
import { pab2019Parser } from './banks/pab-2019';
import { cscb2026Parser } from './banks/cscb-2026';
import { hxb2026Parser } from './banks/hxb-2026';
import { hxb2020Parser } from './banks/hxb-2020';
import { spdb2026Parser } from './banks/spdb-2026';
import { spdb2021Parser } from './banks/spdb-2021';
import { bob2026Parser } from './banks/bob-2026';
import { bob2021Parser } from './banks/bob-2021';

/**
 * 解析器注册表：每银行可注册多个解析器（现役 + 历史旧版），代码注册制。
 * 命名规范：文件 `银行拼音-校准年份.ts`、id `拼音+年份`（现役 `cmb2026`、旧版 `cmb2019`），
 * 未来银行换新模板时新增当年年份解析器（priority 更高），现役解析器永不改名。
 * 白名单制度：定义了标题模式的解析器要求"发件人 + 标题"双命中
 * （如招行"每日信用管家"与账单邮件同发件人，仅凭发件人会误入解析器）。
 */
const registry: RegisteredParser[] = [
  cmbdaily2026Parser,
  cmb2026Parser,
  cmb2020Parser,
  cmb2016Parser,
  icbc2026Parser,
  abc2026Parser,
  abc2019Parser,
  boc2026Parser,
  boc2020Parser,
  cib2026Parser,
  cgb2026Parser,
  psbc2026Parser,
  psbc2022Parser,
  cmbc2026Parser,
  hnb2026Parser,
  bocom2026Parser,
  bocom2019Parser,
  njcb2026Parser,
  njcb2023Parser,
  ceb2026Parser,
  ceb2019Parser,
  ceb2017Parser,
  ceb2016Parser,
  citic2026Parser,
  citic2023Parser,
  citic2020Parser,
  ccb2026Parser,
  hnnxs2026Parser,
  pab2026Parser,
  pab2019Parser,
  cscb2026Parser,
  hxb2026Parser,
  hxb2020Parser,
  spdb2026Parser,
  spdb2021Parser,
  bob2026Parser,
  bob2021Parser,
];

export function registerParser(parser: RegisteredParser): void {
  registry.push(parser);
}

export function listParsers(): RegisteredParser[] {
  return [...registry].sort((a, b) => priorityOf(b) - priorityOf(a));
}

/** 可明确提供银行业务主副卡关系的账单解析器。 */
export function listBusinessRelationshipParsers(): BankParser[] {
  return registry.filter(
    (parser): parser is BankParser => parser.kind !== 'current-cycle-transactions' && parser.businessRelationships === true,
  );
}

/** 解析器优先级：主解析器默认 100（不填即 100），旧版递减 */
function priorityOf(p: RegisteredParser): number {
  return p.priority ?? 100;
}

/** 同一银行的全套解析器，按 priority 降序（主解析器在前，旧版按年代递减） */
function parserKind(parser: RegisteredParser): 'bill' | 'current-cycle-transactions' {
  return parser.kind ?? 'bill';
}

function parsersOfBank(bankName: string, kind: ReturnType<typeof parserKind>): RegisteredParser[] {
  return registry
    .filter((p) => p.bankName === bankName && parserKind(p) === kind)
    .sort((a, b) => priorityOf(b) - priorityOf(a));
}

export function matchParser(from: string, subject: string): ParserMatchResult | null {
  const fromLower = from.toLowerCase();
  const senderHits: RegisteredParser[] = [];
  const subjectHits: RegisteredParser[] = [];
  for (const parser of registry) {
    if (parser.senderPatterns.some((p) => fromLower.includes(p.toLowerCase()))) {
      // 白名单制：定义了标题模式的解析器，标题也须命中才进入（防止同发件人的非账单邮件）
      if (!parser.subjectPatterns || parser.subjectPatterns.some((re) => re.test(subject))) {
        senderHits.push(parser);
      }
    } else if (!parser.requireSender && parser.subjectPatterns?.some((re) => re.test(subject))) {
      subjectHits.push(parser);
    }
  }
  const hits = senderHits.length > 0 ? senderHits : subjectHits;
  if (hits.length === 0) return null;
  // 同银行多解析器命中时取 priority 最高的（旧版解析器由 tryParse 降级兜底）
  const best = [...hits].sort(
    (a, b) => priorityOf(b) - priorityOf(a) || registry.indexOf(a) - registry.indexOf(b),
  )[0]!;
  return { parser: best, matchedBy: senderHits.length > 0 ? 'sender' : 'subject' };
}

export function getParserById(id: string): RegisteredParser | undefined {
  return registry.find((p) => p.id === id);
}

/**
 * 对邮件执行解析，供同步与调试工具共用。一封邮件可解析出多张卡的账单。
 * 自动匹配模式（不传 parserId）：同银行解析器按 priority 降序依次尝试，
 * 主解析器失败（异常或空账单）自动降级旧版解析器，全部失败才记 error（含尝试链）。
 * 指定 parserId：仅用该解析器（解析器中心单测、明细按原解析器重解析）。
 */
export function tryParse(
  mail: MailContext,
  parserId?: string,
):
  | { matched: false; reason: string }
  | {
      matched: true;
      parserId: string;
      bills: ParsedBill[];
      currentCycleTransactions: ParsedCurrentCycleTransactions[];
      error?: string;
    } {
  let chain: RegisteredParser[];
  if (parserId) {
    const parser = getParserById(parserId);
    if (!parser) return { matched: false, reason: `解析器 ${parserId} 不存在` };
    chain = [parser];
  } else {
    const m = matchParser(mail.from, mail.subject);
    if (!m) return { matched: false, reason: '无解析器命中（发件人/标题均不匹配）' };
    chain = parsersOfBank(m.parser.bankName, parserKind(m.parser));
  }

  const attempted: string[] = [];
  let lastError: string | undefined;
  for (const parser of chain) {
    attempted.push(parser.id);
    try {
      if (parser.kind === 'current-cycle-transactions') {
        const currentCycleTransactions = parser.parse(mail);
        if (currentCycleTransactions.length > 0) {
          return { matched: true, parserId: parser.id, bills: [], currentCycleTransactions };
        }
      } else {
        const bills = parser.parse(mail);
        if (bills.length > 0) {
          return { matched: true, parserId: parser.id, bills, currentCycleTransactions: [] };
        }
      }
      // 空账单：疑似旧模板，继续降级尝试
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // 解析异常：继续降级尝试
    }
  }
  const chainText = attempted.join(' → ');
  return {
    matched: true,
    parserId: chain[0]!.id,
    bills: [],
    currentCycleTransactions: [],
    error: `全部解析器解析失败（尝试链: ${chainText}）${lastError ? `；最后错误: ${lastError}` : '；均返回空账单'}`,
  };
}

export type { MailContext, ParsedBill, BankParser } from './types';
