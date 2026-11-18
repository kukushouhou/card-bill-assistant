import { describe, expect, it } from 'vitest';
import { tryParse } from '../src/parsers/registry';
import { fromYmd } from '../src/lib/dates';
import { pabUsdTransactions } from '../src/parsers/pab-usd-transactions';
import type { MailContext } from '../src/parsers/types';

const mail: MailContext = { from: 'creditcard@service.pingan.com', subject: '平安信用卡电子账单', date: fromYmd('2020-03-19') };
const table = (rows: string[][]) => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
const dollarHtml = `美元账户交易明细 USD Account Transaction Detail
  <div>主卡 Main Card</div><div>平安万事达美元白金信用卡********9002 合计金额：$5.07</div>
  ${table([
    ['2020-02-21', '2020-02-22', '示例商户', 'DEU', 'CNY 36.00', '$ 5.12'],
    ['2020-02-24', '2020-02-25', '返现', 'MO', '', '$ -0.05'],
  ])}<div>其他 Other</div>${table([['2020-02-20', '2020-02-21', '自动购汇还款 323.83 汇率 7.0123', '', '', '$ -46.18']])}`;

describe('真实外币版式回归（使用合成身份和金额）', () => {
  it.each(['pab2019', 'pab2026'])('%s 按美元表列读取金额、原币和账户级还款', parserId => {
    const amounts = parserId === 'pab2019' ? '本期应还金额 本期最低应还金额 ￥100.00 $5.07 ￥10.00 $0.25'
      : '本期应还金额 ￥100.00 $5.07 本期最低应还金额 ￥10.00 $0.25';
    const result = tryParse({ ...mail, text: `本期账单日 2020-03-18 本期还款日 2020-04-06 ${amounts}`, html: dollarHtml }, parserId);
    if (!result.matched) throw new Error('未匹配');
    expect(result.error).toBeUndefined();
    const usd = result.bills.find(bill => bill.currency === 'USD');
    expect(usd).toMatchObject({ cardLast4: '9002', amount: 5.07, minAmount: 0.25 });
    expect(usd?.transactions).toMatchObject([
      { amount: 5.12, currency: 'USD', originalAmount: 36, originalCurrency: 'CNY', cardLast4: '9002' },
      { amount: -0.05, currency: 'USD', cardLast4: '9002' },
      { amount: -46.18, currency: 'USD', cardLast4: null },
    ]);
  });

  it('平安缺少原币时留空，金额损坏时报错，不保存部分明细', () => {
    const rows = pabUsdTransactions({ ...mail, html: dollarHtml });
    expect(rows[1]!.originalAmount).toBeUndefined();
    expect(() => pabUsdTransactions({ ...mail, html: dollarHtml.replace('$ 5.12', '金额缺失') })).toThrow('未完整读取');
    expect(() => pabUsdTransactions({ ...mail, text: '美元账户交易明细\n2020-02-21\n2020-02-22\n商户\n$ 5.12' })).toThrow('完整的原邮件表格');
  });

  it('民生按人民币和美元账户标题切换币种，零应还仍保留美元还款明细', () => {
    const text = [
      '本期账单日 Statement Date 2020/12/05 本期最后还款日 Payment Due Date 2020/12/25',
      '人民币/美元账户 RMB/USD Account RMB 100.00 USD 0.00 RMB 10.00 USD 0.00',
      '人民币 RMB', '11/01', '11/02', '人民币商户', '100.00', '9001',
      '美元 USD', '本期应还款金额', 'New Balance', '0.00',
      '11/05', '11/05', '购汇还款', '-5.12', '9002',
      '11/06', '11/07', '示例境外商户 UKR150.00 UAH', '4.10', '9002',
    ].join('\n');
    const result = tryParse({ ...mail, from: 'statement@creditcard.cmbc.com.cn', subject: '民生信用卡电子对账单', text }, 'cmbc2026');
    if (!result.matched) throw new Error('未匹配');
    expect(result.bills).toMatchObject([
      { currency: 'CNY', transactions: [{ currency: 'CNY', amount: 100 }] },
      { currency: 'USD', amount: 0, transactions: [{ currency: 'USD', amount: -5.12 },
        { currency: 'USD', amount: 4.1, originalAmount: 150, originalCurrency: 'UAH' }] },
    ]);
    expect(result.bills[0]!.transactions).toHaveLength(1);
  });

  it('广发促销式月账单标题进入正常解析，真实卡与附属卡关系一并保留', () => {
    const html = table([['9001（9002附）', '100.00', '10.00', '2026/08/15', '人民币']]);
    const result = tryParse({ ...mail, from: 'creditcard@cgbchina.com.cn', subject: '【广发卡 7月账单】超级广发日惊喜来袭！',
      text: '账单周期：2026/06/25-2026/07/24', html });
    expect(result.matched && result.parserId).toBe('cgb2026');
    expect(result.matched && result.bills[0]).toMatchObject({ cardLast4: '9001', amount: 100,
      businessCards: { primaryCardLast4: '9001', supplementaryCards: [{ cardLast4: '9002' }] } });
  });
});
