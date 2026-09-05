/** 浏览器验收专用：全部业务事实为合成数据，数据库入口严格替换为内存代理。 */
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const storage = path.join(root, '.ui-fixture');
await fs.mkdir(storage, { recursive: true });
process.env.SKIN_STORAGE_DIR = path.join(storage, 'skins');
process.env.JWT_SECRET = 'local-ui-fixture-not-a-real-account';
process.env.NODE_ENV = 'development';
const date = (value: string) => new Date(value + 'T00:00:00+08:00');
const todayText = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const month = todayText.slice(0, 7);
const previous = new Date(todayText + 'T12:00:00+08:00'); previous.setMonth(previous.getMonth() - 1);
const period = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(previous);
const cardRows = ['0988', '2233', '6677', '8899', '8855'].map((tail, i) => ({
  id: i + 1, bankName: i < 4 ? '交通银行' : '中信银行', cardLast4: tail, displayLast4: tail,
  holderName: '示例持卡人', nickname: i === 0 ? '日常消费' : null, currency: 'CNY', statementDay: 10,
  dueRule: 'offset', dueDay: null, dueOffsetDays: 25, remindDaysBefore: [3, 1, 0],
  annualFeeDate: null, annualFeeDateManual: false, businessRole: 'standalone', businessPrimaryId: null,
  businessPrimaryCardId: null, businessPrimaryCardLast4: null, billingEditable: true, businessGroupMembers: [],
  source: 'email', status: 'active', hidden: false, hasSecret: i === 0, groupCardIds: i < 4 ? [1, 2, 3, 4] : [5],
  priority: 0, isPrimary: i === 0 || i === 4, primaryManual: false, isBillOwner: i < 2, createdAt: date('2025-01-01'),
}));
let bills: any[] = [
  { id: 101, cardId: 1, period, amount: 8.8, currency: 'CNY', cards: [] },
  { id: 102, cardId: 2, period, amount: 34.6, currency: 'CNY', cards: [] },
  { id: 103, cardId: 1, period, amount: 12.6, currency: 'USD', cards: [{ cardId: 4 }] },
  { id: 104, cardId: 5, period, amount: 1280, currency: 'CNY', cards: [] },
].map(bill => ({ ...bill, statementDate: date(period + '-10'), dueDate: date(todayText), minAmount: .44, paidStatus: 'unpaid', paidAmount: null, paidAt: null, hasDetails: bill.id !== 102, annualFeeAmount: null, source: 'email' }));
for (let i = 0; i < 8; i++) {
  const historic = i < 4 ? '2026-07' : '2025-12';
  bills.push({ id: 200 + i, cardId: i % 4 + 1, period: historic, statementDate: date(historic + '-10'), dueDate: date(historic + '-28'), amount: (i + 1) * 120.1, minAmount: 1, currency: i === 3 ? 'USD' : 'CNY', paidStatus: 'paid', paidAmount: (i + 1) * 120.1, paidAt: date(historic + '-28'), hasDetails: true, annualFeeAmount: null, source: 'email', cards: [] });
}
const withCard = (bill: any) => ({ ...bill, card: cardRows.find(card => card.id === bill.cardId), cards: bill.cards.map((link: any) => ({ ...link, card: cardRows.find(card => card.id === link.cardId) })) });
let transactions = bills.filter(bill => bill.hasDetails).flatMap(bill => [
  { id: bill.id * 10, billId: bill.id, cardId: bill.cardId, cardLast4: cardRows[bill.cardId - 1].cardLast4, bankName: cardRows[bill.cardId - 1].bankName, dateText: '07/28', transactionDate: date('2026-07-28'), description: '日常消费 · 超市', amount: bill.amount, currency: bill.currency, originalAmount: null, originalCurrency: null, sequence: 1 },
  { id: bill.id * 10 + 1, billId: bill.id, cardId: bill.cardId, cardLast4: cardRows[bill.cardId - 1].cardLast4, bankName: cardRows[bill.cardId - 1].bankName, dateText: null, transactionDate: null, description: '账单调整', amount: -.1, currency: bill.currency, originalAmount: null, originalCurrency: null, sequence: 2 },
]);
transactions.push({ id: 9999, billId: null as any, cardId: 2, cardLast4: '2233', bankName: '交通银行', dateText: null, transactionDate: date(todayText), description: '未出账消费', amount: 23.5, currency: 'CNY', originalAmount: null, originalCurrency: null, sequence: 1 });
let occurrences: any[] = [
  { id: 1, name: '每月房租', businessType: 'fixed_bill', amount: 2800, status: 'open' },
  { id: 2, name: '电费', businessType: 'dynamic_bill', amount: null, status: 'open' },
  { id: 3, name: '检查订阅续费', businessType: 'general', amount: null, status: 'open' },
  { id: 4, name: '更新家庭清单', businessType: 'general', amount: null, status: 'completed' },
].map(item => ({ ...item, reminderId: item.id, targetDate: date(todayText), availableDate: date(todayText), daysBefore: [0], completedAt: item.status === 'completed' ? date(todayText) : null, suspended: false, note: null, reminder: { enabled: true } }));
let reminders = occurrences.map(item => ({ id: item.id, name: item.name, businessType: item.businessType, type: 'monthly', interval: 1, dayOfMonth: 5, dayOfWeek: null, monthOfYear: null, specificDate: null, daysBefore: [3, 0], fixedAmount: item.amount, enabled: true, note: null, nextDates: [todayText], nextOccurrences: [], openOccurrenceCount: 1 }));
const stored: Record<string, string> = JSON.parse(await fs.readFile(path.join(storage, 'settings.json'), 'utf8').catch(() => '{}'));
const transactionMatch = (where: any = {}) => transactions.filter(row => {
  if (typeof where.billId === 'number' && row.billId !== where.billId) return false;
  if (where.billId?.not === null && row.billId == null) return false;
  if (where.cardId?.in && !where.cardId.in.includes(row.cardId)) return false;
  if (typeof where.cardId === 'number' && row.cardId !== where.cardId) return false;
  if (where.bill?.period && bills.find(bill => bill.id === row.billId)?.period !== where.bill.period) return false;
  if (where.bankName && row.bankName !== where.bankName) return false;
  if (where.description?.contains && !row.description.includes(where.description.contains)) return false;
  if (where.transactionDate?.gte && (!row.transactionDate || row.transactionDate < where.transactionDate.gte)) return false;
  if (where.transactionDate?.lt && (!row.transactionDate || row.transactionDate >= where.transactionDate.lt)) return false;
  return true;
});
const delegates: Record<string, any> = {
  card: { findMany: async () => cardRows },
  bill: { findMany: async () => bills.map(withCard), findUnique: async ({ where }: any) => { const bill = bills.find(bill => bill.id === where.id); return bill ? withCard(bill) : null; } },
  billTransaction: { count: async ({ where }: any) => transactionMatch(where).length, findMany: async ({ where, skip = 0, take = 100 }: any) => transactionMatch(where).slice(skip, skip + take).map(row => ({ ...row, bill: bills.find(bill => bill.id === row.billId) ? withCard(bills.find(bill => bill.id === row.billId)) : null })) },
  customReminder: { findMany: async () => [] },
  customReminderOccurrence: { findMany: async ({ where = {} }: any = {}) => occurrences.filter(item => (!where.status || item.status === where.status) && !item.suspended) },
  appSetting: { findUnique: async ({ where }: any) => stored[where.key] ? { key: where.key, value: stored[where.key] } : null, upsert: async ({ where, create, update }: any) => { stored[where.key] = stored[where.key] ? update.value : create.value; await fs.writeFile(path.join(storage, 'settings.json'), JSON.stringify(stored)); return { key: where.key, value: stored[where.key] }; } },
};
// 未声明的数据库调用直接失败，绝不会退回真实数据库。
(globalThis as any).prisma = new Proxy(delegates, { get(target, key: string) { if (!(key in target)) throw new Error('验收桩未定义数据库调用：' + key); return target[key]; } });
const { default: agendaRouter } = await import('../src/routes/agenda.routes');
const { default: transactionsRouter } = await import('../src/routes/transactions.routes');
const { default: skinRouter } = await import('../src/routes/skins.routes');
const { activeSkin, skins } = await import('../src/modules/skins/service');
const { loadLedgerData } = await import('../src/modules/bills/ledger-data');
const { summarizeAgenda, billItem, cardBillView } = await import('../src/modules/bills/agenda');
const { listNotificationProviderDefinitions } = await import('../src/notify/registry');
const app = express(); app.use(express.json()); app.use(cookieParser());
let authed = true; let installed = true; let upgrade: any = null; let failNext: string | null = null;
const signed = jwt.sign({ sub: '1', username: 'admin' }, process.env.JWT_SECRET);
app.use((req, res, next) => { if (authed) req.cookies.drc_token = signed; if (failNext && req.path === failNext) { failNext = null; res.status(503).json({ error: '请求暂时失败，请重试' }); } else next(); });
app.post('/__fixture', (req, res) => { if (req.body.reset) { bills = structuredClone(initialData.bills); transactions = structuredClone(initialData.transactions); occurrences = structuredClone(initialData.occurrences); reminders = structuredClone(initialData.reminders); cardRows.splice(0, cardRows.length, ...structuredClone(initialData.cards)); accounts = structuredClone(initialData.accounts); history = structuredClone(initialData.history); channels = []; } if ('authed' in req.body) authed = req.body.authed; if ('installed' in req.body) installed = req.body.installed; if ('upgrade' in req.body) upgrade = req.body.upgrade; if ('failNext' in req.body) failNext = req.body.failNext; res.json({ ok: true }); });
app.get('/api/app', async (_req, res) => res.json({ name: '守候信用卡小管家', skin: await activeSkin() }));
app.get('/api/setup/status', (_req, res) => res.json({ installed, dbOk: true, installedAt: installed ? '2026-01-01' : null, notificationProviders: listNotificationProviderDefinitions() }));
app.post('/api/setup/install', async (req, res) => { installed = true; authed = false; if (req.body.skinId) await delegates.appSetting.upsert({ where: { key: 'appearance.skin' }, create: { value: JSON.stringify({ id: req.body.skinId, version: '1.0.0' }) }, update: { value: JSON.stringify({ id: req.body.skinId, version: '1.0.0' }) } }); res.json({ ok: true }); });
app.get('/api/auth/me', (_req, res) => authed ? res.json({ username: 'admin', pin: { hasPin: true, locked: false, lockedUntil: null } }) : res.status(401).json({ error: '未登录' }));
app.post('/api/auth/login', (_req, res) => { authed = true; res.json({ ok: true }); });
app.post('/api/auth/logout', (_req, res) => { authed = false; res.json({ ok: true }); });
app.post('/api/auth/pin/verify', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/password', (_req, res) => res.json({ ok: true }));
app.get('/api/upgrades', (_req, res) => res.json(upgrade));
app.use('/api/skins', skinRouter); app.use('/api/agenda', agendaRouter); app.use('/api/transactions', transactionsRouter);
app.get('/api/cards', async (_req, res) => {
  const ledger = (await loadLedgerData()).rows;
  res.json(cardRows.map(card => { const rows = ledger.filter(bill => bill.cardId === card.id && bill.period === period); const row = rows[0]; return { ...card, currentCycle: { period, statementDate: row?.statementDate ?? date(period + '-10'), dueDate: row?.dueDate ?? date(todayText), hasBill: !!row?.id, missing: !row?.id, amount: row?.amount ?? null, minAmount: row?.minAmount ?? null, paidStatus: row?.paidStatus ?? null, currency: 'CNY', billCount: rows.length, unpaidBillCount: rows.filter(bill => bill.paidStatus !== 'paid').length, cardTails: [card.cardLast4] } }; }));
});
app.put('/api/cards/:id', (req, res) => { Object.assign(cardRows.find(card => card.id === Number(req.params.id))!, req.body); res.json({ ok: true }); });
app.post('/api/cards/:id/secret/view', (_req, res) => res.json({ cardNoFull: '4111111111110988', expDate: '12/29', cvv: '123' }));
app.put('/api/bills/:id/paid', (req, res) => { const bill = bills.find(bill => bill.id === Number(req.params.id)); if (!bill) { res.status(404).json({ error: '账单不存在' }); return; } bill.paidStatus = req.body.action === 'full' ? 'paid' : req.body.action === 'partial' ? 'partial' : 'unpaid'; bill.paidAmount = req.body.action === 'full' ? bill.amount : req.body.paidAmount ?? null; res.json({ ok: true }); });
app.delete('/api/bills/:id', (req, res) => { const id = Number(req.params.id); bills = bills.filter(bill => bill.id !== id); transactions = transactions.filter(row => row.billId !== id); res.json({ ok: true }); });
app.get('/api/bills/summary', async (_req, res) => { const rows = (await loadLedgerData()).rows; const sum = summarizeAgenda(rows.map(row => billItem(cardBillView(row)))); res.json({ ...sum, totalAmount: 3000, unpaidCount: 5, unpaidTotal: 1323.4, totalsByCurrency: sum.totalsByCurrency.map(item => ({ currency: item.currency, totalAmount: item.amount, unpaidCount: 4, unpaidTotal: item.amount })) }); });
app.get('/api/bills/trend', (_req, res) => res.json({ months: 6, currency: 'CNY', currencies: ['CNY', 'USD'], items: [1, 2, 3, 4, 5, 6].map((n) => ({ period: '2026-0' + n, total: n * 520 + (n % 2) * 300, count: n * 3 })) }));
app.get('/api/reminders/custom', (_req, res) => res.json(reminders));
app.post('/api/reminders/custom/preview', (_req, res) => res.json({ dates: [todayText] }));
app.post('/api/reminders/custom', (req, res) => { reminders.push({ ...req.body, id: Date.now(), nextDates: [todayText], nextOccurrences: [], openOccurrenceCount: 0 }); res.json({ ok: true }); });
app.put('/api/reminders/custom/:id', (req, res) => { Object.assign(reminders.find(item => item.id === Number(req.params.id))!, req.body); res.json({ ok: true }); });
app.delete('/api/reminders/custom/:id', (req, res) => { reminders = reminders.filter(item => item.id !== Number(req.params.id)); res.json({ ok: true }); });
app.post('/api/reminders/occurrences/:id/complete', (req, res) => { const item = occurrences.find(row => row.id === Number(req.params.id)); item.status = 'completed'; item.completedAt = new Date(); res.json({ ok: true }); });
app.put('/api/reminders/occurrences/:id/paid', (req, res) => { const item = occurrences.find(row => row.id === Number(req.params.id)); item.status = req.body.action === 'paid' ? 'paid' : 'open'; if (req.body.amount != null) item.amount = req.body.amount; res.json({ ok: true }); });
app.get('/api/reminders/todos', async (_req, res) => { const rows = (await loadLedgerData()).rows.filter(row => row.paidStatus !== 'paid'); res.json({ items: rows.slice(0, 4).map(row => ({ ...row, recordType: 'card', action: 'card_payment', billId: row.id, hasBill: !!row.id })) }); });
app.get('/api/reminders/upcoming', (_req, res) => res.json({ items: [{ sourceKey: 'card:1:due', type: 'due', date: todayText, title: '交通银行 · 0988', detail: '还款日', amount: 8.8, minAmount: .44, currency: 'CNY', paid: false, paidStatus: 'unpaid', paidAmount: null, daysLeft: 0, hasBill: true, cardId: 1, billId: 101, period }] }));
app.post('/api/jobs/reminders/run', (_req, res) => res.json({ pushed: 4, skipped: 1, failed: 0 }));
app.get('/api/dashboard/summary', (_req, res) => res.json({ date: date(todayText), cards: { total: 5, active: 5, withSecret: 1 }, currentPeriod: { period: month, bills: 4, unpaidCount: 4, unpaidTotal: 1323.4, unknownAmountCount: 1, annualFeeCount: 0, annualFeeTotal: 0, currency: 'CNY', totalsByCurrency: [{ currency: 'CNY', unpaidCount: 4, unpaidTotal: 1323.4, annualFeeTotal: 0 }] }, annualFeeNotice: null, upcoming14d: { dueCount: 4, statementCount: 0, feeCount: 0, customCount: 1 }, email: { total: 1, enabled: 1, lastSyncAt: date(todayText) }, customs: { total: 3, enabled: 3 } }));
let accounts = [{ id: 1, email: 'demo@example.test', imapHost: 'imap.example.test', imapPort: 993, tls: true, authUser: 'demo@example.test', enabled: true, lastSyncAt: date(todayText), syncDays: 30, createdAt: date('2025-01-01') }];
let history = { running: false, startedAt: null as any, finishedAt: null, total: 0, processed: 0, matched: 0, unmatched: 0, image: 0, errors: 0, error: null };
app.get('/api/email/accounts', (_req, res) => res.json(accounts));
app.post('/api/email/accounts/test', (_req, res) => res.json({ mailboxCount: 24 }));
app.put('/api/email/accounts/:id', (req, res) => { Object.assign(accounts[0], req.body); res.json({ ok: true }); });
app.post('/api/email/accounts', (req, res) => { accounts.push({ ...req.body, id: accounts.length + 1 }); res.json({ ok: true }); });
app.get('/api/email/accounts/:id/history-sync', (_req, res) => res.json(history));
app.post('/api/email/accounts/:id/history-sync', (_req, res) => { history = { ...history, running: true, total: 24, processed: 8, matched: 8, startedAt: new Date() }; res.json(history); });
app.post('/api/email/accounts/:id/sync', (_req, res) => res.json({ synced: 4, matched: 4, unmatched: 0, image: 0, errors: 0 }));
app.get('/api/email/logs', (_req, res) => res.json({ total: 1, page: 1, pageSize: 20, items: [{ id: 1, accountId: 1, uid: 1234, from: 'bank@example.test', subject: '信用卡电子账单', status: 'matched', parserId: 'bcm2026', billId: 101, mailDate: date(todayText), emailAccount: accounts[0], error: null }] }));
app.get('/api/email/parsers', (_req, res) => res.json([{ id: 'bcm2026', name: '交通银行', bankName: '交通银行', priority: 100, senderPatterns: ['bank@example.test'], subjectPatterns: ['信用卡电子账单'], description: '信用卡电子账单', enabled: true }]));
app.post('/api/email/dry-run', (_req, res) => res.json({ results: [{ uid: 1234, subject: '信用卡电子账单', from: 'bank@example.test', date: date(todayText), parserId: 'bcm2026', parsed: true, bills: [{ bankName: '交通银行', cardLast4: '0988', period, amount: 8.8, currency: 'CNY', statementDate: period + '-10', dueDate: todayText }], error: null }] }));
app.get('/api/email/accounts/:id/messages/:uid', (req, res) => res.json({ uid: Number(req.params.uid), subject: '信用卡电子账单', from: 'bank@example.test', date: date(todayText), attachments: [], text: '交通银行电子账单（示例）\n卡尾 0988\n应还金额 8.80 元' }));
let channels: any[] = [];
app.get('/api/settings', (_req, res) => res.json({ notifications: { providers: listNotificationProviderDefinitions(), channels }, reminderHour: 8 }));
app.put('/api/settings/notification-channels/:type', (req, res) => { channels = [...channels.filter(item => item.type !== req.params.type), { type: req.params.type, name: req.params.type, configured: true, ...req.body }]; res.json({ ok: true }); });
app.post('/api/settings/notification-channels/:type/test', (_req, res) => res.json({ ok: true }));
app.use('/api', (_req, res) => res.status(404).json({ error: '该验收接口未配置' }));
app.use((error: any, _req: any, res: any, _next: any) => { console.error(error.message); res.status(error.status ?? (error.issues ? 400 : 500)).json({ error: error.message }); });
let vite: { close: () => Promise<void> } | undefined;
if (process.env.UI_FIXTURE_STATIC === '1') {
  const dist = path.join(root, 'web/dist');
  app.use(express.static(dist));
  app.get('/{*page}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('../../web/node_modules/vite/dist/node/index.js');
  const development = await createServer({ root: path.join(root, 'web'), configFile: path.join(root, 'web/vite.config.ts'), server: { middlewareMode: true }, optimizeDeps: { force: true }, appType: 'spa' });
  vite = development; app.use(development.middlewares);
}
const initialData = structuredClone({ bills, transactions, occurrences, reminders, cards: cardRows, accounts, history });
const server = app.listen(4173, '127.0.0.1', () => console.log('UI fixture ready http://127.0.0.1:4173'));
process.on('SIGINT', async () => { await vite?.close(); server.close(() => process.exit(0)); });
// 暴露导出范本准备能力仅供本地验收脚本，不启动任何业务调度器。
await skins.list();
