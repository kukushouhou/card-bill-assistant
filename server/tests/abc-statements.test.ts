import { describe, expect, it } from 'vitest';
import { tryParse } from '../src/parsers/registry';
import { abc2026Parser } from '../src/parsers/banks/abc-2026';
import { abcpdf2026Parser } from '../src/parsers/banks/abcpdf-2026';
import { abcTextTransactions } from '../src/parsers/statement-rows';
import { fromYmd, ymd } from '../src/lib/dates';
import type { MailContext } from '../src/parsers/types';

const mail: MailContext = { from: 'e-statement@creditcard.abchina.com.cn',
  subject: '中国农业银行金穗信用卡电子对账单', date: fromYmd('2026-11-18') };
const header = '卡号 Card No 622222******9001 账单周期 Statement Cycle 2026/10/17-2026/11/16 到期还款日 Payment Due Date 2026/12/05';
const total = '本期应还款额(欠款为-) New Balance';
const minimum = '最低还款额(欠款为-) Min Payment';
const summary = `${total} 人民币(CNY) -30.00 美元(USD) -18.39 ${minimum} 人民币(CNY) -3.00 美元(USD) -0.00`;
const table = (rows: string[][]) => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;

// 保留两份实样的提取顺序、分页位置与正负方向，身份、摘要和金额使用合成数据。
function pdf(transactionCount: number, tail = '9001', amounts = '人民币(CNY) -70.00 人民币(CNY) -7.00') {
  const rows = Array.from({ length: transactionCount }, (_, index) =>
    `261115 261116 ${tail} ${index === 0 ? '还款' : '合成商户'} ${index === 0 ? '-100.00/CNY 100.00/CNY' : '10.00/CNY -10.00/CNY'}`);
  rows.splice(4, 0, '2/2');
  return `卡号\nCard No\n账单周期\nStatement Cycle\n到期还款日\nPayment Due Date\n${total} ${minimum}\n信用额度 Credit Limit
交易日期 T Date 入账日期 P Date 卡号后四位 Card No. 交易描述 Description 交易金额/币种 Tran Amt/Curr 入账金额/币种 Sett Amt/Curr
1/2
·农业银行信用卡对账单2026年11月（补）·
您的信用卡账户 Statement Information
622222******${tail} 2026/10/17-2026/11/16 2026/12/05
${amounts}
额度信息
人民币(CNY) 50000.00
交易明细
${rows.join('\n')}
温馨提示`;
}

describe('农行常规外币及补寄 PDF', () => {
  it('纯美元 HTML 分格摘要保留最低额零值，日元消费归入美元账单', () => {
    const html = table([
      ['卡号', 'Card No', '622222******9001'], ['账单周期', 'Statement Cycle', '2026/10/17-2026/11/16'],
      ['到期还款日', 'Payment Due Date', '2026/12/05'],
      [total], ['美元(USD)', '-18.39'], [minimum], ['美元(USD)', '-0.00'],
      ['261115', '261116', '9001', '合成商户', '2900.00/JPY', '-18.39/USD'],
    ]);
    const result = tryParse({ ...mail, html });
    expect(result.matched && result.parserId).toBe('abc2026');
    expect(result.matched && result.bills).toMatchObject([{ currency: 'USD', amount: 18.39, minAmount: 0,
      transactions: [{ amount: 18.39, currency: 'USD', originalAmount: 2900, originalCurrency: 'JPY' }] }]);
  });

  it('同卡双币保留两张账单，无明细的外币账户也保留', () => {
    const bills = abc2026Parser.parse({ ...mail, text: `${header} ${summary}\n261115 261116 9001 商户 30.00/CNY -30.00/CNY` });
    expect(bills).toMatchObject([{ currency: 'CNY', amount: 30, minAmount: 3, transactions: [{ amount: 30 }] },
      { currency: 'USD', amount: 18.39, minAmount: 0, transactions: [] }]);
  });

  it('各币种分别重复标签时，按币种配对应还和最低额', () => {
    const bills = abc2026Parser.parse({ ...mail, text: `${header} ${total} 人民币(CNY) -30.00 ${minimum} 人民币(CNY) -3.00
      ${total} 美元(USD) -18.39 ${minimum} 美元(USD) -0.00 信用额度 Credit Limit 人民币(CNY) 50000.00` });
    expect(bills.map(bill => [bill.currency, bill.amount, bill.minAmount])).toEqual([['CNY', 30, 3], ['USD', 18.39, 0]]);
  });

  it('文本保留跨行摘要、空卡尾、原币与冲抵方向', () => {
    const rows = abcTextTransactions('261115 261116 9001 合成\n商户 2900.00/JPY -18.39/USD\n261115 261116 费用返还 -2.00/USD 2.00/USD');
    expect(rows).toMatchObject([{ description: '合成 商户', amount: 18.39, currency: 'USD', originalAmount: 2900, originalCurrency: 'JPY' },
      { cardLast4: null, amount: -2, currency: 'USD' }]);
  });

  it('HTML 和文本同样保留明确三字母币种', () => {
    const text = `${header} ${total} 瑞士法郎(CHF) -1.00 ${minimum} 瑞士法郎(CHF) 0.00`;
    const row = ['261115', '261116', '9001', '合成商户', '1.00/CHF', '-1.00/CHF'];
    const htmlBill = abc2026Parser.parse({ ...mail, text, html: table([row]) })[0]!;
    const textBill = abc2026Parser.parse({ ...mail, text: `${text}\n${row.join(' ')}` })[0]!;
    expect(htmlBill.transactions).toEqual(textBill.transactions);
    expect(htmlBill.currency).toBe('CHF');
  });

  it.each([8, 10])('正文为空的补寄 PDF 完整解析 %i 笔跨页明细，额度不会串入摘要', count => {
    const result = tryParse({ ...mail, text: '', html: '\r\n', pdfText: pdf(count) });
    expect(result.matched && result.parserId).toBe('abcpdf2026');
    if (!result.matched) throw new Error('未命中');
    expect(result.bills).toHaveLength(1);
    const bill = result.bills[0]!;
    expect(bill).toMatchObject({ cardLast4: '9001', currency: 'CNY', amount: 70, minAmount: 7 });
    expect(ymd(bill.statementDate)).toBe('2026-11-16');
    expect(ymd(bill.dueDate)).toBe('2026-12-05');
    expect(bill.transactions).toHaveLength(count);
    expect(bill.transactions?.map(row => row.amount)).toEqual([-100, ...Array(count - 1).fill(10)]);
  });

  it('PDF 双币摘要按行配对，外币明细归入对应账户', () => {
    const text = pdf(0, '9001', '人民币(CNY) -30.00 人民币(CNY) -3.00\n美元(USD) -18.39 美元(USD) -0.00')
      + '\n261115 261116 9001 合成商户 2900.00/JPY -18.39/USD';
    const bills = abcpdf2026Parser.parse({ ...mail, pdfText: text });
    expect(bills).toMatchObject([{ currency: 'CNY', amount: 30, minAmount: 3, transactions: [] },
      { currency: 'USD', amount: 18.39, minAmount: 0, transactions: [{ amount: 18.39, originalCurrency: 'JPY' }] }]);
  });

  it('多个 PDF 提取结果拼接后分别归属各自卡号', () => {
    const bills = abcpdf2026Parser.parse({ ...mail, pdfText: `${pdf(8)}\n${pdf(10, '9002')}` });
    expect(bills.map(bill => [bill.cardLast4, bill.transactions?.length])).toEqual([['9001', 8], ['9002', 10]]);
  });

  it.each([
    `${header} ${total} 人民币(CNY) -30.00 美元(USD) 缺失 ${minimum} 人民币(CNY) -3.00`,
    `${header} ${total} 人民币(CNY) -30.00 ${minimum} 美元(USD) -3.00`,
    `${header} ${total} 人民币(CNY) -30.00 ${minimum} 人民币(CNY) -3.00\n261115 261116 9001 商户 1.00/USD -1.00/USD`,
  ])('摘要不完整或明细币种缺少账单时整封报错', text => {
    const result = tryParse({ ...mail, text });
    expect(result.matched && result.bills).toHaveLength(0);
    expect(result.matched && result.error).toBeTruthy();
  });

  it('PDF 最低额缺失和损坏明细都不保存部分结果', () => {
    expect(() => abcpdf2026Parser.parse({ ...mail, pdfText: pdf(0, '9001', '人民币(CNY) -10.00') })).toThrow('不完整');
    expect(() => abcpdf2026Parser.parse({ ...mail, pdfText: pdf(8) + '\n261115 261116 9001 残缺明细' })).toThrow('未完整读取');
  });
});
