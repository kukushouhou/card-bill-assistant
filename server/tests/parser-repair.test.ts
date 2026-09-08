import { describe, expect, it } from 'vitest';
import { tryParse } from '../src/parsers/registry';
import { abcTextTransactions, attachStatementTransactions, htmlTransactions, fiveColumnTextTransactions, assertCompleteRecords } from '../src/parsers/statement-rows';
import { bocPdfTransactions } from '../src/parsers/boc-pdf-rows';
import { repaymentLowerBound, restoredPayment } from '../src/modules/upgrades/migrations/statement-repair';
import { fromYmd, ymd } from '../src/lib/dates';
import type { MailContext, ParsedBill } from '../src/parsers/types';

const table = (rows: string[][]) => '<table>' + rows.map((row) => '<tr>' + row.map((cell) => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</table>';
const mail = (text: string, html?: string): MailContext => ({ from: '', subject: '', date: fromYmd('2026-08-14'), text, html });
const bill = (tail: string): ParsedBill => ({ bankName: '建设银行', cardLast4: tail, amount: 20, minAmount: 2, currency: 'CNY',
  period: '2026-08', statementDate: fromYmd('2026-08-14'), dueDate: fromYmd('2026-09-03') });

describe('0.5 原文记录完整性回归', () => {
  it('农行从真实 HTML 行读取两笔美团，摘要欠款符号翻转，重复金额不去重', () => {
    const body = mail('卡号 Card No 625336******1170 账单周期 Statement Cycle 2026/07/14-2026/08/13 到期还款日 Payment Due Date 2026/09/07 本期应还款额(欠款为-) New Balance 人民币(CNY) -19.85 最低还款额(欠款为-) Min Payment 人民币(CNY) -1.98', table([
      ['260811', '260812', '1170', '美团支付', '1.94/CNY', '-1.94/CNY'],
      ['260812', '260813', '1170', '美团支付<br>订单说明', '17.91/CNY', '-17.91/CNY'],
      ['260812', '260813', '', '费用返还', '-2.00/CNY', '2.00/CNY'],
    ]));
    const result = tryParse(body, 'abc2026');
    expect(result.matched && result.bills[0]?.amount).toBe(19.85);
    expect(result.matched && result.bills[0]?.minAmount).toBe(1.98);
    expect(result.matched && result.bills[0]?.transactions?.map((row) => row.amount)).toEqual([1.94, 17.91, -2]);
    expect(result.matched && result.bills[0]?.transactions?.[2]?.cardLast4).toBeNull();
  });
  it('农行描述中的日期不会截断，跨行和空尾号均保留', () => {
    expect(abcTextTransactions('20250523\n20250523\n4027\n年费贷调（客服）\n20250523\n-580.00/CNY\n580.00/CNY\n20250524 20250524 账单分期 10.00/CNY -10.00/CNY')
      .map((row) => [row.amount, row.cardLast4])).toEqual([[-580, '4027'], [10, null]]);
  });
  it('中信取账户余额和最低还款列，兼容 RMB 明细', () => {
    const body = mail('账单日 2026年08月13日 Statement Date 到期还款日 2026年09月01日 Payment Due Date 6229-19**-****-5983 CNY 100.00 80.00 50.00 70.00 3.50', table([
      ['20260812', '20260813', '5983', '', '测试商户', 'RMB 50.00', 'RMB 50.00'],
    ]));
    const result = tryParse(body, 'citic2026');
    expect(result.matched && result.bills[0]).toMatchObject({ amount: 70, minAmount: 3.5, transactions: [{ amount: 50 }] });
  });
  it('同日同额转入转出保留方向，扫码卡尾读取，旧卡不虚构账单归属', () => {
    const transactions = htmlTransactions(mail('', table([
      ['2026-08-01', '2026-08-02', '9490/扫码', '扫码消费', 'CNY', '77.00', 'CNY', '77.00'],
      ['2026-08-01', '2026-08-02', '6075', '溢缴款转出', 'CNY', '77.00', 'CNY', '77.00'],
      ['2026-08-01', '2026-08-02', '9490', '溢缴款转入', 'CNY', '-77.00', 'CNY', '-77.00'],
    ])), 'ccb')!;
    const bills = [bill('9490'), bill('9386')]; attachStatementTransactions(bills, transactions);
    expect(bills[0]!.transactions?.map((t) => [t.amount, t.cardLast4, !!t.statementShared])).toEqual([[77, '9490', false], [77, '6075', true], [-77, '9490', false]]);
    expect(bills[1]!.amount).toBe(20);
  });
  it.each(['five', 'hxb', 'cib'] as const)('%s 换行描述保持完整且取入账列', (layout) => {
    const cells = layout === 'five' ? ['20260801', '20260802', '商户<br>门店', 'RMB:17.91', '1111']
      : layout === 'hxb' ? ['08/01', '08/02', '商户<br>门店', '1111', '-￥17.91']
        : ['2026-08-01 12:30', '2026-08-02', '商户<br>门店', 'HKD 51.00', 'CNY 45.51'];
    const rows = htmlTransactions(mail('', table([cells])), layout)!;
    expect(rows).toHaveLength(1); expect(rows[0]!.description).toBe('商户 门店');
    expect(rows[0]!.amount).toBe(layout === 'cib' ? 45.51 : layout === 'hxb' ? -17.91 : 17.91);
  });
  it('只有还款区或消费区的交行明细仍完整读取', () => {
    for (const heading of ['还款／退货／费用返还明细', '消费、取现、其他费用明细']) {
      const rows = htmlTransactions(mail('', heading + table([['2023-03-11', '2023-03-11', '测试交易', 'CNY 2.00', 'CNY 2.00']])), 'bocom')!;
      expect(rows[0]!.amount).toBe(heading.startsWith('还款') ? -2 : 2);
    }
  });
  it('纯文本记录允许连续排版及换行，原币不能覆盖入账币种', () => {
    expect(fiveColumnTextTransactions('2026/08/01 2026/08/02 商户\n门店 RMB: 17.91 1111 2026/08/03 2026/08/04 还款 RMB:-17.91 1111', /^RMB:(-?[\d,]+\.\d{2})$/)
      .map((row) => row.amount)).toEqual([17.91, -17.91]);
    expect(htmlTransactions(mail('', table([['20260801', '20260802', '1111', '境外商户', 'USD 10.00', 'CNY 70.00']])), 'citic')?.[0])
      .toMatchObject({ amount: 70, currency: 'CNY', originalAmount: 10, originalCurrency: 'USD' });
  });
  it('识别到日期对却缺金额时显式失败，不静默漏行', () => {
    expect(() => htmlTransactions(mail('', table([['20260801', '20260802', '测试商户', '金额缺失', '1111']])), 'five')).toThrow('无法完整读取');
    expect(() => assertCompleteRecords('编号 156908 2029/08/31', 0)).not.toThrow();
  });
  it('邮储无分隔符日期和后续记录不会遗漏，残缺记录明确失败', () => {
    const header = '(2023年08月) 尾号为1111 账单日 27 本期应还款总额 ￥17.91 本期最低还款额 ￥1.79 到期还款日 2023年09月19日\n';
    const body = mail(header + '20230801\n20230802\n商户\n门店\n￥1.94\n1111\n20230803\n20230804\n商户二\n￥17.91\n1111');
    const result = tryParse(body, 'psbc2022');
    expect(result.matched && result.bills[0]?.transactions?.map((t) => t.amount)).toEqual([1.94, 17.91]);
    const broken = tryParse(mail(body.text! + '\n20230805 20230806 残缺交易'), 'psbc2022');
    expect(broken.matched && broken.bills).toEqual([]);
    expect(broken.matched && broken.error).toContain('未完整读取');
  });
  it('光大美元区在前不会串读人民币，PDF 全角美元符号可识别', () => {
    const text = '特为您呈上2016年04月13日至2016年05月12日信用卡账户变动情况。您最晚于2016年05月31日还款\n'
      + '美元账户\n00000000****1111\n测试卡\n2.00\n2.00\n1.00\n美元账户交易明细\n2016/05/01 2016/05/02 1111 外币交易 2.00\n'
      + '人民币账户\n00000000****1111\n测试卡\n20.00\n20.00\n2.00\n人民币账户交易明细\n2016/05/01 2016/05/02 1111 人民币交易 20.00';
    const old = tryParse(mail(text), 'ceb2016');
    expect(old.matched && old.bills.map((b) => [b.currency, b.amount, b.transactions?.map((t) => t.amount)]))
      .toEqual([['CNY', 20, [20]], ['USD', 2, [2]]]);
    const body = mail(''); body.pdfText = '账单日 Statement Date 2017-01-12 到期还款日 Payment Due Date 2017-01-31 '
      + 'RMB Statement Balance ￥20.00 USD Statement Balance ＄2.00 人民币账户 Account Number : 00000000****1111 '
      + '2017/01/01 2017/01/02 1111 消费 20.00 Minimum Payment Due 2.00 美元账户 Account Number : 00000000****1111 '
      + '2017/01/01 2017/01/02 1111 外币消费 2.00 Minimum Payment Due 1.00';
    const pdf = tryParse(body, 'ceb2017');
    expect(pdf.matched && pdf.bills.map((b) => [b.currency, b.amount, b.transactions?.length])).toEqual([['CNY', 20, 1], ['USD', 2, 1]]);
    body.pdfText = body.pdfText.replace(/Minimum Payment Due 1\.00$/, '');
    const unknownMinimum = tryParse(body, 'ceb2017');
    expect(unknownMinimum.matched && unknownMinimum.bills.find((b) => b.currency === 'USD')?.minAmount).toBeUndefined();
  });
  it('光大金额列为空的分期说明不把描述内余额记作交易', () => {
    const body = mail('', '人民币账户交易明细' + table([
      ['2019/07/01', '2019/07/02', '1111', '消费', '20.00'],
      ['2019/07/01', '2019/07/02', '1111', '账单分期 (分期) 2,246.02', ''],
      ['2019/07/12', '2019/07/12', '1111', '7月份账单分期3期：本期应还款748.00，余额1,498.02 ，余期为02期', ''],
    ]));
    expect(htmlTransactions(body, 'ceb')?.map((t) => t.amount)).toEqual([20]);
    expect(htmlTransactions(mail('', '美元账户交易明细' + table([
      ['2019/07/01', '2019/07/02', '1111', '外币交易', '', '2.99'],
    ])), 'ceb')?.[0]).toMatchObject({ currency: 'USD', amount: 2.99 });
  });
  it('广发同一汇总单元格的两张卡都保留，描述换行不猜主副卡', () => {
    const html = table([['1111 2222', '19.85', '1.99', '2026/09/15', '人民币']])
      + '卡号：0000********1111' + table([['2026/08/01', '2026/08/02', '商户一', '1.94', '人民币', '1.94', '人民币']])
      + '卡号：0000********2222' + table([['2026/08/03', '2026/08/04', '商户二<br>门店', '17.91', '人民币', '17.91', '人民币']]);
    const result = tryParse(mail('账单周期:2026/07/27-2026/08/26', html), 'cgb2026');
    expect(result.matched && result.bills[0]?.cardLast4s).toEqual(['1111', '2222']);
    expect(result.matched && result.bills[0]?.businessCards).toBeUndefined();
    expect(result.matched && result.bills[0]?.transactions?.map((t) => [t.amount, t.cardLast4])).toEqual([[1.94, '1111'], [17.91, '2222']]);
  });
  it('中行用 PDF 存入列判定方向，不会把描述中的汇率当金额', () => {
    const body = mail(''); body.pdfText = '测试卡(卡号：0053)\n外币/USD\n2026-05-20 2026-05-20 0053 缤纷生活APP[汇率683.01\n]23.14';
    body.pdfPages = [{ attachment: 0, page: 1, width: 600, height: 800, items: [
      { text: '测试卡(卡号：0053)', x: 20, y: 700, width: 100, height: 10 },
      { text: '外币/USD', x: 20, y: 680, width: 50, height: 10 },
      { text: 'Deposit', x: 420, y: 660, width: 30, height: 10 }, { text: 'Expenditure', x: 510, y: 660, width: 40, height: 10 },
      { text: '2026-05-20', x: 20, y: 640, width: 45, height: 10 }, { text: '2026-05-20', x: 120, y: 640, width: 45, height: 10 },
      { text: '0053', x: 240, y: 640, width: 20, height: 10 }, { text: '23.14', x: 425, y: 640, width: 25, height: 10 },
    ] }];
    expect(bocPdfTransactions(body)).toEqual([expect.objectContaining({ amount: -23.14, currency: 'USD', cardLast4: '0053', description: '缤纷生活APP[汇率683.01 ]' })]);
    body.pdfPages[0]!.items = body.pdfPages[0]!.items.filter((item) => !/^(Deposit|Expenditure)$/.test(item.text));
    expect(() => bocPdfTransactions(body)).toThrow('缺少存入／支出列');
  });
});

describe('升级还款恢复窗口', () => {
  it.each([['2026-09-08', '2026-08-08'], ['2026-03-31', '2026-02-28'], ['2024-03-31', '2024-02-29'], ['2026-01-31', '2025-12-31']])('%s 往前一个日历月', (anchor, expected) => {
    expect(ymd(repaymentLowerBound(fromYmd(anchor)))).toBe(expected);
  });
  it('包含下限当天及未来日期，保护更早账单和手动还款', () => {
    const lower = fromYmd('2026-08-08');
    const row = (date: string) => ({ amount: -19.85, paidAmount: -19.85, paidStatus: 'paid', paidAt: fromYmd(date), dueDate: fromYmd(date) });
    expect(restoredPayment(row('2026-08-07'), 19.85, lower)).toBeNull();
    expect(restoredPayment(row('2026-08-08'), 19.85, lower)?.paidStatus).toBe('unpaid');
    expect(restoredPayment(row('2027-01-01'), 19.85, lower)?.paidStatus).toBe('unpaid');
    expect(restoredPayment({ ...row('2026-09-07'), paidAt: new Date('2026-09-07T13:15:00+08:00') }, 19.85, lower)).toBeNull();
    expect(restoredPayment(row('2026-09-07'), -19.85, lower)).toBeNull();
    expect(restoredPayment({ ...row('2026-09-07'), amount: 19.85, paidAmount: 19.85 }, 19.85, lower)).toBeNull();
  });
});
