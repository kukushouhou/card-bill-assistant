/**
 * 解析器框架类型定义
 */

export interface MailContext {
  /** 发件人地址（可能含多个，取第一个即可，由调用方拼接） */
  from: string;
  subject: string;
  date: Date;
  text?: string;
  html?: string;
  /** PDF 附件提取的文本（账单正文在附件里的银行，如中国银行） */
  pdfText?: string;
  /** HTML 附件提取的文本（GBK 解码后原文，如工商银行 2018-2019 对账单附件） */
  attachText?: string;
}

/** 单笔交易明细；解析完成后由账单流水线持久化。 */
export interface ParsedTransaction {
  /** 交易日文本原样（如 '08-14' / '2026/08/14'），不强制解析避免跨年误判 */
  date?: string | null;
  description: string;
  /** 金额：正=入账（消费/费用），负=冲抵（还款/返还） */
  amount: number;
  /** 入账币种；缺省时继承所属账单币种。 */
  currency?: string;
  /** 银行同时提供原交易金额/币种时保留，amount/currency 仍表示入账口径。 */
  originalAmount?: number | null;
  originalCurrency?: string | null;
  /** 交易所属卡尾号（合并账单多卡时用于区分归属；费用行/分期等解析阶段留空） */
  cardLast4?: string | null;
}

/** 尚未形成正式账单的日度交易；时间来自银行邮件，不依赖账单日推断。 */
export interface ParsedCurrentCycleTransaction extends ParsedTransaction {
  transactionAt: Date;
}

export interface ParsedCurrentCycleTransactions {
  bankName: string;
  transactions: ParsedCurrentCycleTransaction[];
}

export interface ParsedBill {
  bankName: string;
  /** 卡号后 4 位，匹配卡档案的关键；无法提取时用 '----' */
  cardLast4: string;
  holderName?: string;
  /** 按卡尾号的持卡人姓名（仅区块明确写出时入映射；合账阶段才兜底） */
  holderMap?: Record<string, string | null>;
  /** 应还总额（负数表示溢缴款） */
  amount: number;
  /** 最低还款额 */
  minAmount?: number;
  currency: string;
  /** 银行明确给出的账期开始日；缺失时不得猜测。 */
  cycleStartDate?: Date;
  statementDate: Date;
  dueDate: Date;
  /** 账单期次 'YYYY-MM'（出账日所在月） */
  period: string;
  /** 邮件中若含完整卡号，仅作展示参考，不会入库 */
  cardNoFull?: string;
  /**
   * 合并账单（一封邮件多张卡）中出现的全部卡尾号，主卡在前。
   * 未提供时按单卡 [cardLast4] 处理；各卡共享本账单金额与还款义务。
   */
  cardLast4s?: string[];
  /** 本期交易明细；合账后持久化并用于账单/全局明细查询。 */
  transactions?: ParsedTransaction[];
}

interface ParserBase {
  /** 解析器 ID（银行拼音 + 校准年份，如 'cmb2026'；旧版如 'cmb2019'） */
  id: string;
  bankName: string;
  /**
   * 解析优先级：主解析器默认 100（不填即 100），旧版解析器递减（90、80...）。
   * 同银行多解析器按 priority 降序尝试：主解析器失败自动降级旧版。
   */
  priority?: number;
  /** 发件人地址匹配模式（子串匹配，如 '@message.cmbchina.com'） */
  senderPatterns: string[];
  /** 备用：标题正则匹配（白名单制，仅账单类标题） */
  subjectPatterns?: RegExp[];
  /** true 时禁止仅凭标题兜底，必须同时命中发件域名。 */
  requireSender?: boolean;
}

export interface BankParser extends ParserBase {
  kind?: 'bill';
  /** 解析邮件（一封邮件可含多张卡的账单），失败返回空数组。 */
  parse(mail: MailContext): ParsedBill[];
}

export interface CurrentCycleTransactionParser extends ParserBase {
  kind: 'current-cycle-transactions';
  /** 仅解析尚未正式出账的当前账期交易。 */
  parse(mail: MailContext): ParsedCurrentCycleTransactions[];
}

export type RegisteredParser = BankParser | CurrentCycleTransactionParser;

export interface ParserMatchResult {
  parser: RegisteredParser;
  matchedBy: 'sender' | 'subject';
}
