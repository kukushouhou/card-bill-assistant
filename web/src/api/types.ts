// 与服务端路由响应对齐的类型定义

export interface PinStatus {
  hasPin: boolean;
  locked: boolean;
  lockedUntil: string | null;
}

export interface AppInfo {
  name: string;
}

export type UpgradeMigrationMode = 'silent' | 'optional' | 'required';

export interface UpgradeMigrationSummary {
  key: string;
  targetVersion: string;
  order: number;
  mode: UpgradeMigrationMode;
  title: string;
  description: string;
  total: number;
  summary: string | null;
}

export interface UpgradeTask {
  key: string;
  mode: Exclude<UpgradeMigrationMode, 'silent'>;
  targetVersion: string;
  order: number;
  title: string;
  description: string;
  executeLabel: string;
  ignoreLabel: string | null;
  status: 'awaiting_decision' | 'approved' | 'ignored' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  error: string | null;
}

export interface UpgradePlan {
  id: number;
  fromVersion: string | null;
  toVersion: string;
  status: 'awaiting_decision' | 'executing' | 'failed';
  hasRequired: boolean;
  runtimeMode: 'required_wait' | 'optional_wait' | 'executing' | 'failed';
  error: string | null;
  migrations: UpgradeMigrationSummary[];
  tasks: UpgradeTask[];
}

export interface SetupStatus {
  installed: boolean;
  dbOk: boolean;
  installedAt: string | null;
  /** 新版服务端提供；兼容升级期间的旧服务端可缺省。 */
  notificationProviders?: NotificationProviderDefinition[];
}

export interface NotificationProviderField {
  key: string;
  label: string;
  type: 'url' | 'text' | 'password' | 'select';
  placeholder?: string;
  description?: string;
  required: boolean;
  advanced?: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface NotificationProviderDefinition {
  type: string;
  name: string;
  description: string;
  fields: NotificationProviderField[];
  configMode?: 'fields' | 'custom-http';
}

export interface NotificationChannelInfo {
  type: string;
  name: string;
  enabled: boolean;
  configured: true;
  config: Record<string, unknown>;
}

export interface NotificationSettingsInfo {
  providers: NotificationProviderDefinition[];
  channels: NotificationChannelInfo[];
}

export interface MeInfo {
  username: string;
  pin: PinStatus;
}

export interface CardCurrentCycle {
  period: string;
  statementDate: string;
  dueDate: string;
  hasBill: boolean;
  /** 上一期已过出账日且无真实账单（过还款日 30 天后为 false） */
  missing: boolean;
  amount: number | null;
  minAmount: number | null;
  paidStatus: string | null;
  currency: string | null;
  billCount: number;
  unpaidBillCount: number;
  /** 合并账单全部关联卡尾号（含本卡，普通账单仅本卡） */
  cardTails: string[];
}

export interface CardRow {
  id: number;
  bankName: string;
  /** 匹配尾号（邮件账单匹配用，不参与搜索） */
  cardLast4: string;
  /** 展示尾号（卡面与搜索用） */
  displayLast4: string;
  /** 内部优先级：消费金额累加，不向用户展示 */
  priority: number;
  holderName: string | null;
  /** 卡片别名（用户自定义辨识名，如"银联钻石卡"） */
  nickname: string | null;
  currency: string;
  statementDay: number;
  dueRule: 'fixed' | 'offset';
  dueDay: number | null;
  dueOffsetDays: number | null;
  remindDaysBefore: number[];
  /** 年费收取日（YYYY-MM-DD，仅月-日有语义），null=未设置 */
  annualFeeDate: string | null;
  /** true=用户手动设置，自动识别不覆盖 */
  annualFeeDateManual: boolean;
  /** 账单明确的业务身份；standalone 表示普通套卡。 */
  businessRole: 'standalone' | 'primary' | 'secondary' | 'supplementary';
  businessPrimaryCardId: number | null;
  businessPrimaryCardLast4: string | null;
  billingEditable: boolean;
  businessGroupMembers: Array<{
    id: number;
    cardLast4: string;
    role: 'primary' | 'secondary' | 'supplementary';
  }>;
  source: string;
  status: 'active' | 'frozen' | 'closed';
  hasSecret: boolean;
  /** 套卡内全部卡 ID（按出账日与还款规则归组，含本卡；单卡组仅自身） */
  groupCardIds: number[];
  /** 套卡内优先显示卡 */
  isPrimary: boolean;
  /** 用户指定的优先显示卡 */
  primaryManual: boolean;
  /** 本卡是否承接当期账单（标识字段，不参与自动选定） */
  isBillOwner: boolean;
  currentCycle: CardCurrentCycle;
  createdAt: string;
}

export interface CardDetail extends CardRow {
  secretFields: { cardNoFull: boolean; expDate: boolean; cvv: boolean };
  bills: BillRow[];
}

export interface CardInput {
  bankName: string;
  cardLast4?: string;
  holderName?: string | null;
  nickname?: string | null;
  currency?: string;
  statementDay: number;
  dueRule: 'fixed' | 'offset';
  dueDay?: number | null;
  dueOffsetDays?: number | null;
  remindDaysBefore?: number[];
  annualFeeDate?: string | null;
  status?: 'active' | 'frozen' | 'closed';
}

/** 账单台账行：真实账单 + 「未取得账单」占位行统一结构 */
export interface BillRow {
  recordType: 'card' | 'custom';
  /** 占位行（未取得账单）无库记录，id 为 null */
  id: number | null;
  cardId: number | null;
  bankName: string | null;
  cardLast4: string | null;
  /** 合并账单全部卡尾（主卡在前）；普通账单/占位行为单尾号 */
  cardTails: string[];
  period: string;
  statementDate: string | null;
  dueDate: string;
  /** null = 未取得账单且未手动标记，显示 - */
  amount: number | null;
  /** 当前待还金额；未取得账单时为 null */
  remainingAmount: number | null;
  minAmount: number | null;
  currency: string;
  /** 三态还款状态：'paid' 已结清 / 'partial' 部分已还 / 'unpaid' 待还；占位行为 null */
  paidStatus: 'paid' | 'partial' | 'unpaid' | null;
  paidAt: string | null;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount: number | null;
  /** 该期邮件含交易明细 */
  hasDetails: boolean;
  /** 本期年费（正数非退还合计），null=无 */
  annualFeeAmount: number | null;
  /** 'email'=邮件解析 / 'manual'=手动标记 / 'missing'=未取得占位行 */
  source: 'email' | 'manual' | 'missing' | 'custom';
  /** true = 未取得账单占位行（可弹窗标记） */
  missing: boolean;
  /** 已过还款日且未履行最低还款的天数；未逾期为 null */
  daysOverdue: number | null;
  customOccurrenceId: number | null;
  customReminderId: number | null;
  customBusinessType: 'fixed_bill' | 'dynamic_bill' | null;
  customName: string | null;
  note: string | null;
}

/** 单笔交易明细（实时拉取源邮件解析，不入库） */
export interface ParsedTransaction {
  id?: number;
  /** 交易日文本原样（银行原文格式） */
  date?: string | null;
  description: string;
  /** 金额：正=入账（消费/费用），负=冲抵（还款/返还） */
  amount: number;
  currency?: string;
  transactionDate?: string | null;
  originalAmount?: number | null;
  originalCurrency?: string | null;
  /** 合并账单中该笔交易所属卡尾（单卡账单无此字段） */
  cardLast4?: string | null;
}

export interface BillDetails {
  period: string;
  currency: string;
  transactions: ParsedTransaction[];
  annualFeeAmount: number | null;
}

export interface PagedBills {
  total: number;
  page: number;
  pageSize: number;
  items: BillRow[];
}

export type CustomReminderBusinessType = 'general' | 'fixed_bill' | 'dynamic_bill';
export type CustomReminderScheduleType = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CustomReminderInput {
  name: string;
  businessType: CustomReminderBusinessType;
  type: CustomReminderScheduleType;
  interval: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  monthOfYear: number | null;
  specificDate: string | null;
  daysBefore: number[];
  fixedAmount: number | null;
  note: string | null;
  enabled: boolean;
  disableMode?: 'keep_open' | 'suspend_open';
}

export interface CustomReminder extends CustomReminderInput {
  id: number;
  nextDates: string[];
}

/** 今日提醒事件（含结构化字段，供前端快速标记还款） */
export interface ReminderEvent {
  type: 'card_due' | 'card_statement' | 'card_fee' | 'custom';
  cardId?: number;
  refId?: number;
  occurrenceId?: number;
  businessType?: CustomReminderBusinessType;
  bankName?: string;
  cardLast4?: string;
  /** 相关账期（card_fee 为年费计入的账期） */
  period?: string | null;
  title: string;
  body: string;
  fireDate: string;
  /** 该期还款日 */
  dueDate?: string | null;
  billId?: number | null;
  hasBill?: boolean;
  amount?: number | null;
  minAmount?: number | null;
  currency?: string | null;
  paidStatus?: string | null;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount?: number | null;
  /** 合并账单共享卡数（含主卡，1=普通账单） */
  linkedCount?: number;
  targetDate?: string;
}

export interface UpcomingItem {
  /** 列表稳定唯一键，由提醒来源与账期/日期组成 */
  sourceKey: string;
  date: string;
  type: 'due' | 'statement' | 'custom' | 'fee';
  title: string;
  detail: string;
  amount: number | null;
  minAmount: number | null;
  currency: string | null;
  /** 是否已结清（null=无账单） */
  paid: boolean | null;
  /** 三态还款状态：'paid' | 'partial' | 'unpaid'（null=无账单） */
  paidStatus: string | null;
  /** 已还金额（partial 时有意义；full 时等于应还金额） */
  paidAmount: number | null;
  daysLeft: number;
  hasBill: boolean;
  cardId?: number;
  billId?: number | null;
  period?: string | null;
  /** 合并账单共享卡数（含主卡，1=普通账单） */
  linkedCount?: number;
  customOccurrenceId?: number | null;
  customBusinessType?: CustomReminderBusinessType | null;
  customAction?: 'complete' | 'pay' | null;
  actionable?: boolean;
}

/** 今日待办行（仪表盘）：还款日 < 今天+3 天的未还账期，按还款日升序 */
export interface TodoItem {
  recordType: 'card' | 'custom';
  action: 'card_payment' | 'custom_payment' | 'complete';
  /** 未取得账单占位行没有数据库记录 */
  billId?: number | null;
  cardId?: number;
  bankName?: string;
  /** 合并账单全部卡尾（归属卡在前），普通账单仅本卡 */
  cardTails?: string[];
  period?: string;
  statementDate?: string;
  dueDate: string;
  amount: number | null;
  minAmount?: number | null;
  currency?: string;
  paidStatus: 'partial' | 'unpaid' | string | null;
  paidAmount?: number | null;
  /** true = 未取得账单占位行 */
  missing?: boolean;
  /** 逾期天数（还款日已过且未还；未逾期为 null） */
  daysOverdue: number | null;
  occurrenceId?: number;
  businessType?: CustomReminderBusinessType;
  name?: string;
  note?: string | null;
}

export interface AnnualFeeNotice {
  billCount: number;
  acknowledgeThroughBillId: number;
  items: Array<{
    billId: number;
    bankName: string;
    cardTails: string[];
    period: string;
    currency: string;
    annualFeeAmount: number;
    hasDetails: boolean;
  }>;
  banks: Array<{
    bankName: string;
    billCount: number;
    cardTails: string[];
    totalsByCurrency: Array<{
      currency: string;
      amount: number;
    }>;
  }>;
}

export interface DashboardSummary {
  date: string;
  cards: { total: number; active: number; withSecret: number };
  currentPeriod: {
    period: string;
    bills: number;
    unpaidCount: number;
    unpaidTotal: number;
    unknownAmountCount: number;
    /** 本期含年费账单数 */
    annualFeeCount: number;
    /** 本期年费合计 */
    annualFeeTotal: number;
    currency: string;
    totalsByCurrency: Array<{
      currency: string;
      unpaidCount: number;
      unpaidTotal: number;
      annualFeeTotal: number;
    }>;
  };
  /** 游标之后仍未还款的年费账单聚合；null=无需显著提醒 */
  annualFeeNotice: AnnualFeeNotice | null;
  upcoming14d: { dueCount: number; statementCount: number; feeCount: number; customCount: number };
  email: { total: number; enabled: number; lastSyncAt: string | null };
  customs: { total: number; enabled: number };
}

/** 金额走势（无数据月份 total=null 断线） */
export interface TrendItem {
  period: string;
  total: number | null;
  count: number;
}

export interface BillsTrend {
  months: number;
  currency: string;
  currencies: string[];
  items: TrendItem[];
}

/** 台账统计（当前筛选范围合计） */
export interface BillsSummary {
  billCount: number;
  totalAmount: number;
  unpaidCount: number;
  unpaidTotal: number;
  unknownAmountCount: number;
  totalsByCurrency: Array<{
    currency: string;
    totalAmount: number;
    unpaidCount: number;
    unpaidTotal: number;
  }>;
}

export interface TransactionRow {
  id: number;
  billId: number | null;
  period: string;
  unbilled: boolean;
  bankName: string;
  cardId: number | null;
  cardLast4: string | null;
  date: string | null;
  transactionDate: string | null;
  description: string;
  amount: number;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
}

export interface PagedTransactions {
  total: number;
  page: number;
  pageSize: number;
  items: TransactionRow[];
}

/** 历史拉取进度 */
export interface HistorySyncState {
  running: boolean;
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

export interface EmailAccount {
  id: number;
  email: string;
  imapHost: string;
  imapPort: number;
  tls: boolean;
  authUser: string;
  enabled: boolean;
  lastUid: number;
  lastSyncAt: string | null;
  syncDaysBack: number;
}

export interface MailLogRow {
  id: number;
  accountId: number;
  uid: number;
  fromAddress: string;
  subject: string;
  mailDate: string;
  status: string;
  parserId: string | null;
  billIds: number[];
  error: string | null;
  processedAt: string;
}

export interface PagedMailLogs {
  total: number;
  page: number;
  pageSize: number;
  items: MailLogRow[];
}

export interface ParserInfo {
  id: string;
  bankName: string;
  senderPatterns: string[];
  subjectPatterns: string[];
}

export interface ParsedBillInfo {
  bankName: string;
  cardLast4: string;
  holderName?: string;
  amount: number;
  minAmount?: number;
  currency: string;
  statementDate: string;
  dueDate: string;
  period: string;
}

export interface DryRunResult {
  uid: number;
  from: string;
  subject: string;
  date: string;
  parserId: string | null;
  parsed: boolean;
  bills?: ParsedBillInfo[];
  currentCycleTransactionCount?: number;
  error?: string;
}

export interface MailBody {
  uid: number;
  from: string;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  pdfText: string | null;
  attachments: Array<{ filename: string; size: number }>;
}

export interface SyncSummary {
  synced: number;
  matched: number;
  unmatched: number;
  /** 图片账单数（正文无文本、金额在图片里） */
  image: number;
  errors: number;
}

export interface SettingsInfo {
  reminderHour: number;
  notifications: NotificationSettingsInfo;
}
