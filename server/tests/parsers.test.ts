import { describe, expect, it } from 'vitest';
import { inferCardRule } from '../src/parsers/pipeline';
import { cmb2026Parser } from '../src/parsers/banks/cmb-2026';
import { cmb2020Parser } from '../src/parsers/banks/cmb-2020';
import { cmbdaily2026Parser } from '../src/parsers/banks/cmbdaily-2026';
import { abc2019Parser } from '../src/parsers/banks/abc-2019';
import { cmbc2026Parser } from '../src/parsers/banks/cmbc-2026';
import { bob2026Parser } from '../src/parsers/banks/bob-2026';
import { boc2026Parser } from '../src/parsers/banks/boc-2026';
import { icbc2026Parser } from '../src/parsers/banks/icbc-2026';
import { ceb2019Parser } from '../src/parsers/banks/ceb-2019';
import { ceb2017Parser } from '../src/parsers/banks/ceb-2017';
import { ceb2016Parser } from '../src/parsers/banks/ceb-2016';
import { citic2023Parser } from '../src/parsers/banks/citic-2023';
import { hnb2026Parser } from '../src/parsers/banks/hnb-2026';
import { hxb2026Parser } from '../src/parsers/banks/hxb-2026';
import { pab2026Parser } from '../src/parsers/banks/pab-2026';
import { njcb2023Parser } from '../src/parsers/banks/njcb-2023';
import {
  applyTransactionTails,
  detectAnnualFeeAmount,
  isAnnualFeeCharge,
  isAnnualFeeDateEvidence,
} from '../src/parsers/_util';
import type { ParsedBill, ParsedTransaction } from '../src/parsers/types';
import { listParsers, matchParser, tryParse } from '../src/parsers/registry';
import { fromYmd } from '../src/lib/dates';

describe('inferCardRule', () => {
  it('还款日与出账日相差 18 天 → offset 规则', () => {
    const rule = inferCardRule(fromYmd('2026-08-05'), fromYmd('2026-08-23'));
    expect(rule).toEqual({ statementDay: 5, dueRule: 'offset', dueOffsetDays: 18, dueDay: null });
  });

  it('跨月账单（出账 8-28，还款 9-16，相差 19 天）仍为 offset', () => {
    const rule = inferCardRule(fromYmd('2026-08-28'), fromYmd('2026-09-16'));
    expect(rule.dueRule).toBe('offset');
    expect(rule.dueOffsetDays).toBe(19);
  });

  it('相差超过 40 天 → 退化为固定日模式', () => {
    const rule = inferCardRule(fromYmd('2026-08-01'), fromYmd('2026-10-15'));
    expect(rule.dueRule).toBe('fixed');
    expect(rule.dueDay).toBe(15);
  });

  it('还款日早于出账日（脏数据）→ 固定日模式', () => {
    const rule = inferCardRule(fromYmd('2026-08-10'), fromYmd('2026-08-05'));
    expect(rule.dueRule).toBe('fixed');
  });
});

describe('解析器注册表', () => {
  it('37 个现役及历史解析器全部注册且 id 唯一', () => {
    const parsers = listParsers();
    expect(parsers).toHaveLength(37);
    expect(new Set(parsers.map((parser) => parser.id)).size).toBe(parsers.length);
  });

  it('按发件人+标题白名单匹配招行解析器', () => {
    const m = matchParser('ccsvc@message.cmbchina.com', '招商银行信用卡电子账单');
    expect(m?.parser.id).toBe('cmb2026');
    expect(m?.matchedBy).toBe('sender');
  });

  it('每日信用管家精确进入独立日度解析器', () => {
    const match = matchParser('ccsvc@message.cmbchina.com', '每日信用管家');
    expect(match?.parser.id).toBe('cmbdaily2026');
    expect(match?.parser.kind).toBe('current-cycle-transactions');
    expect(matchParser('someone@example.com', '每日信用管家')).toBeNull();
    expect(matchParser('ccsvc@message.cmbchina.com', '每日信用管家活动')).toBeNull();
  });

  it('按标题正则兜底匹配', () => {
    const m = matchParser('someone@example.com', '招商银行信用卡电子账单');
    expect(m?.parser.id).toBe('cmb2026');
    expect(m?.matchedBy).toBe('subject');
  });

  it('不相关邮件不匹配', () => {
    expect(matchParser('noreply@github.com', 'Your PR was merged')).toBeNull();
  });
});

describe('cmb2026Parser.parse（账户级合并账单）', () => {
  // 实测摘要行格式：账单周期 额度 应还总额 最低还款 到期还款日
  const sampleText = [
    '尊敬的王小明先生：',
    '2026/07/09-2026/08/08 ￥ 35,000.00 ￥ 1,927.79 ￥ 96.39 2026/08/26',
    '您的信用卡账单已出，请及时还款。',
  ].join('\n');

  const mail = { from: 'ccsvc@message.cmbchina.com', subject: '招商银行信用卡电子账单', date: new Date(), text: sampleText };

  it('完整解析：金额、日期、期次（账户级无卡号用 ----）', () => {
    const bills = cmb2026Parser.parse(mail);
    expect(bills).toHaveLength(1);
    const bill = bills[0];
    expect(bill.bankName).toBe('招商银行');
    expect(bill.cardLast4).toBe('----');
    expect(bill.holderName).toBe('王小明');
    expect(bill.amount).toBeCloseTo(1927.79);
    expect(bill.minAmount).toBeCloseTo(96.39);
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2026-08-08').toISOString());
    expect(bill.cycleStartDate?.toISOString()).toBe(fromYmd('2026-07-09').toISOString());
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2026-08-26').toISOString());
    expect(bill.period).toBe('2026-08');
  });

  it('tryParse 端到端：命中解析器并产出账单', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.parserId).toBe('cmb2026');
      expect(result.bills[0]?.cardLast4).toBe('----');
      expect(result.bills[0]?.amount).toBeCloseTo(1927.79);
    }
  });

  it('缺少摘要行时返回空数组', () => {
    const broken = { ...mail, text: '尊敬的王小明：您的信用卡账单已出，请及时还款。' };
    expect(cmb2026Parser.parse(broken)).toEqual([]);
  });

  it('HTML 邮件：剥标签后可解析', () => {
    const htmlMail = {
      ...mail,
      text: undefined,
      html: `<p>尊敬的李小华女士：</p><p>2026/07/10-2026/08/10 ￥ 20,000.00 ￥ 1,000.00 ￥ 100.00 2026/08/28</p>`,
    };
    const bills = cmb2026Parser.parse(htmlMail);
    expect(bills).toHaveLength(1);
    expect(bills[0].holderName).toBe('李小华');
    expect(bills[0].amount).toBeCloseTo(1000);
    expect(bills[0].dueDate.toISOString()).toBe(fromYmd('2026-08-28').toISOString());
  });

  it('还款日早于出账日的异常数据被拒绝', () => {
    const bad = {
      ...mail,
      text: '2026/07/09-2026/08/08 ￥ 35,000.00 ￥ 1,927.79 ￥ 96.39 2026/08/01',
    };
    expect(cmb2026Parser.parse(bad)).toEqual([]);
  });

  it('招行特例：0000 后无 CN 视为没卡号，0000 后有 CN 保留卡尾', () => {
    const feeMail = {
      ...mail,
      text: [
        '尊敬的王小明先生：',
        '2026/01/09-2026/02/08 ￥ 35,000.00 ￥ 36.00 ￥ 36.00 2026/02/26',
        '费用',
        '0208',
        '会员费-增值服务使用费',
        '￥36.00',
        '0000',
        '消费',
        '0115',
        '商户消费',
        '￥100.00',
        '3096',
        'CN',
      ].join('\n'),
    };
    const bills = cmb2026Parser.parse(feeMail);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.transactions).toEqual([
      expect.objectContaining({ description: '会员费-增值服务使用费', cardLast4: null }),
      expect.objectContaining({ description: '商户消费', cardLast4: '3096' }),
    ]);
    expect(bills[0]!.cardLast4).toBe('3096');
  });
});

describe('cmbdaily2026Parser.parse（当前账期未出账明细）', () => {
  const mail = {
    from: 'ccsvc@message.cmbchina.com',
    subject: '每日信用管家',
    date: new Date('2026-08-20T05:01:03.000Z'),
    text: [
      '尊敬的客户，截至昨日最后一笔交易，您的额度和积分信息如下：',
      '2026/08/19 您的消费明细如下：',
      '02:38:56',
      'USD 1.36',
      '尾号2111 邮购 COMMANDCODE.AI SAN FRANCISCOCA US',
      '23:57:01',
      'CNY 286.00',
      '尾号7190 消费 美团支付-原绑定卡:3096',
      '23:58:00',
      'CNY -9.90',
      '退货 支付宝退款',
    ].join('\n'),
  };

  it('提取时间、外币、退款、明确卡尾并忽略描述里的其他卡尾', () => {
    const batches = cmbdaily2026Parser.parse(mail);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.transactions).toEqual([
      expect.objectContaining({
        amount: 1.36,
        currency: 'USD',
        cardLast4: '2111',
        description: '邮购 COMMANDCODE.AI SAN FRANCISCOCA US',
      }),
      expect.objectContaining({
        amount: 286,
        currency: 'CNY',
        cardLast4: '7190',
        description: '消费 美团支付-原绑定卡:3096',
      }),
      expect.objectContaining({ amount: -9.9, cardLast4: null, description: '退货 支付宝退款' }),
    ]);
    expect(batches[0]!.transactions[0]!.transactionAt).toEqual(
      new Date(fromYmd('2026-08-19').getTime() + 2 * 3_600_000 + 38 * 60_000 + 56_000),
    );
  });

  it('tryParse 不进入招商正式账单降级链', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.parserId).toBe('cmbdaily2026');
    expect(result.bills).toEqual([]);
    expect(result.currentCycleTransactions[0]!.transactions).toHaveLength(3);
  });

  it('相似标题与正式月账单均不由日度解析器处理', () => {
    expect(cmbdaily2026Parser.parse({ ...mail, subject: '每日信用管家活动' })).toEqual([]);
    expect(cmbdaily2026Parser.parse({ ...mail, subject: '招商银行信用卡电子账单' })).toEqual([]);
  });
});

describe('年费金额与日期证据', () => {
  it('实际年费同时进入金额与日期链', () => {
    const transaction = { date: '08-01', description: '年费', amount: 300 };
    expect(isAnnualFeeCharge(transaction)).toBe(true);
    expect(isAnnualFeeDateEvidence(transaction)).toBe(true);
    expect(detectAnnualFeeAmount([transaction])).toBe(300);
  });

  it('多笔实际年费合计', () => {
    expect(
      detectAnnualFeeAmount([
        { date: '08-01', description: '信用卡年费', amount: 200 },
        { date: '08-02', description: '附属卡年费', amount: 100 },
      ]),
    ).toBe(300);
  });

  it('年费返还/退回/冲销/减免不进入实际年费金额', () => {
    expect(
      detectAnnualFeeAmount([
        { description: '年费返还', amount: 300 },
        { description: '年费退回', amount: 300 },
        { description: '年费冲销', amount: 300 },
        { description: '免年费', amount: 300 },
        { description: '年费减免', amount: 300 },
      ]),
    ).toBeNull();
  });

  it('负数年费（冲抵）与无关描述不计', () => {
    expect(
      detectAnnualFeeAmount([
        { description: '年费', amount: -300 },
        { description: '超市消费', amount: 88 },
      ]),
    ).toBeNull();
  });

  it('无明细返回 null', () => {
    expect(detectAnnualFeeAmount(undefined)).toBeNull();
    expect(detectAnnualFeeAmount([])).toBeNull();
  });

  it('金额合计保留两位小数', () => {
    expect(
      detectAnnualFeeAmount([
        { description: '年费', amount: 0.1 },
        { description: '年费', amount: 0.2 },
      ]),
    ).toBe(0.3);
  });

  it('零元刷免只进入日期链，不产生年费金额', () => {
    const cmb = { date: '0801', description: '消费6次免年费300元', amount: 0 };
    const icbc = { date: '2026-06-21', description: '年费减免 减免年费2000.00元', amount: 0 };
    expect(isAnnualFeeDateEvidence(cmb)).toBe(true);
    expect(isAnnualFeeDateEvidence(icbc)).toBe(true);
    expect(detectAnnualFeeAmount([cmb, icbc])).toBeNull();
  });

  it('普通零元交易不是年费日期证据', () => {
    expect(isAnnualFeeDateEvidence({ description: '积分兑换', amount: 0 })).toBe(false);
  });
});

describe('bob2026Parser.parse（5 行组明细 + 明细行末卡尾归属）', () => {
  const sampleText = [
    '北京银行信用卡对账单',
    '本期账单日:2026年08月20日',
    '本期到期还款日:2026年09月09日',
    '本期应还款金额：',
    '1,505.50 元',
    '最低还款金额：',
    '75.28 元',
    '交易日',
    '记账日',
    '2026/07/25',
    '2026/07/25',
    '支付宝-中国移动通信集团广东有限',
    'RMB:9.50',
    '8594',
    '2026/08/10',
    '2026/08/10',
    '云闪付还款 6222020000000000',
    'RMB:-2,399.64',
    '8594',
  ].join('\n');

  const mail = {
    from: 'service@ebill.bankofbeijing.com.cn',
    subject: '北京银行-信用卡2026年08月电子账单',
    date: new Date(),
    text: sampleText,
  };

  it('解析明细：正数=支出、负数=还款，明细卡尾即账单归属卡', () => {
    const bills = bob2026Parser.parse(mail);
    expect(bills).toHaveLength(1);
    const bill = bills[0]!;
    expect(bill.cardLast4).toBe('8594');
    expect(bill.amount).toBeCloseTo(1505.5);
    expect(bill.transactions).toHaveLength(2);
    expect(bill.transactions![0]).toMatchObject({ description: '支付宝-中国移动通信集团广东有限', amount: 9.5, cardLast4: '8594' });
    expect(bill.transactions![1]).toMatchObject({ description: '云闪付还款 6222020000000000', amount: -2399.64, cardLast4: '8594' });
  });
});

describe('abc2019Parser.parse（旧模板抬头卡与明细卡套卡归属）', () => {
  it('抬头卡继续承接账单，明细中的其他真实卡尾加入 cardLast4s', () => {
    const text = [
      '625336******1170',
      '20210314-20210413',
      '到期还款日',
      '20210508',
      'Card No.',
      'Statement Cycle',
      'Payment Due Date',
      'New Balance',
      '709.46',
      '97.23',
      '50000.00',
      '20210401',
      '20210402',
      '5446',
      '网上消费',
      '测试商户',
      '-12.00/CNY',
      '-12.00/CNY',
    ].join('\n');
    const bills = abc2019Parser.parse({
      from: 'e-statement@creditcard.abchina.com',
      subject: '中国农业银行金穗信用卡电子对账单',
      date: new Date(),
      text,
    });

    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      cardLast4: '1170',
      cardLast4s: ['1170', '5446'],
      period: '2021-04',
      amount: 709.46,
      minAmount: 97.23,
    });
    expect(bills[0]!.transactions).toEqual([
      expect.objectContaining({ date: '20210401', cardLast4: '5446', amount: 12 }),
    ]);
  });
});

describe('icbc2026Parser.parse（账户级多卡、多币种与 HTML 附件）', () => {
  it('7640 承接整套卡账单，1225/6769/7640 明细按入账币种拆账', () => {
    const attachmentText = [
      '贷记卡到期还款日 2026年8月25日',
      '对账单生成日 2026年07月31日',
      '7640(牡丹贷记卡) 人民币(本位币) 8,411.90/RMB 1,429.79/RMB',
      '1225',
      '2026-07-01',
      '2026-07-02',
      '境外消费',
      '12.00/USD',
      '88.00/CNY(支出)',
      '6769',
      '2026-07-03',
      '2026-07-04',
      '超市消费',
      '20.00/CNY',
      '20.00/CNY(支出)',
      '7640',
      '2026-07-05',
      '2026-07-06',
      '年费减免',
      '0.00/CNY',
      '0.00/CNY(支出)',
      '1225',
      '2026-07-07',
      '2026-07-08',
      '美元账户消费',
      '2.68/USD',
      '2.68/USD(支出)',
    ].join('</div><div>');
    const bills = icbc2026Parser.parse({
      from: 'webmaster@icbc.com.cn',
      subject: '中国工商银行客户对账单(ICBC Peony Card Bank Statement)',
      date: new Date(),
      text: '您的信用卡对账单见附件。',
      attachText: `<div>${attachmentText}</div>`,
    });

    expect(bills).toHaveLength(2);
    const cny = bills.find((bill) => bill.currency === 'CNY')!;
    const usd = bills.find((bill) => bill.currency === 'USD')!;
    expect(cny).toMatchObject({
      cardLast4: '7640',
      cardLast4s: ['7640', '1225', '6769'],
      amount: 8411.9,
      minAmount: 1429.79,
    });
    expect(cny.transactions).toHaveLength(3);
    expect(cny.transactions![0]).toMatchObject({
      cardLast4: '1225',
      amount: 88,
      currency: 'CNY',
      originalAmount: 12,
      originalCurrency: 'USD',
    });
    expect(usd).toMatchObject({
      cardLast4: '7640',
      cardLast4s: ['7640', '1225', '6769'],
      amount: 0,
      minAmount: 0,
    });
    expect(usd.transactions).toHaveLength(1);
  });
});

describe('cmbc2026Parser.parse（明细行末卡尾 → 合并账单批量副卡）', () => {
  const sampleText = [
    '尊敬的王小明先生：',
    '本期账单日 Statement Date 2026/08/05',
    '本期最后还款日 Payment Due Date 2026/08/25',
    '人民币/美元账户 RMB/USD Account RMB 528.96 USD 0.00 RMB 100.00 USD 0.00',
    '消 费',
    '08/01',
    '08/02',
    '美团-餐饮',
    '68.00',
    '1234',
    '08/03',
    '08/04',
    '京东-购物',
    '460.96',
    '5678',
    '还 款',
    '07/20',
    '07/21',
    '自动还款',
    '-500.00',
    '1234',
  ].join('\n');

  const mail = {
    from: 'master@creditcard.cmbc.com.cn',
    subject: '民生信用卡2026年08月电子对账单',
    date: new Date(),
    text: sampleText,
  };

  it('明细多卡尾 → 合并卡组，并按汇总生成 CNY/USD 独立账单', () => {
    const bills = cmbc2026Parser.parse(mail);
    expect(bills).toHaveLength(2);
    const bill = bills.find((item) => item.currency === 'CNY')!;
    expect(bill.cardLast4).toBe('1234');
    expect(bill.cardLast4s).toEqual(['1234', '5678']);
    expect(bill.amount).toBeCloseTo(528.96);
    expect(bill.transactions).toHaveLength(3);
    expect(bill.transactions![0]).toMatchObject({ description: '美团-餐饮', amount: 68, cardLast4: '1234' });
    expect(bill.transactions![1]).toMatchObject({ description: '京东-购物', amount: 460.96, cardLast4: '5678' });
    expect(bill.transactions![2]).toMatchObject({ description: '自动还款', amount: -500, cardLast4: '1234' });
    expect(bills.find((item) => item.currency === 'USD')).toMatchObject({
      cardLast4: '1234',
      cardLast4s: ['1234', '5678'],
      amount: 0,
      minAmount: 0,
      currency: 'USD',
    });
  });
});

describe('boc2026Parser.parse（PDF 明细 + 还款符号推断）', () => {
  // 模拟 PDF 提取文本：中文为自定义字体乱码，数字/卡号/ASCII 完好
  const pdfText = [
    '中国银行信用卡账单(2026年08月)',
    'Current FCY Total Balance Due 2026-08-24 2026-08-04 5,534.55',
    '6259 0611 **** 1831 2861.30 286.00',
    ' Modi字卡(卡号：1831)ૃ',
    '人ࡇ币/RMB 㺬࠮/DEBT 2710.40 2861.30 2710.40 㺬࠮/DEBT 2861.30 25738.70',
    '2026-07-14 2026-07-15 1831 微信-便利店CHN 1085.00',
    '2026-07-17 2026-07-18 1831ୣ ৻૴ૃ（云୺付） 2710.40',
    '2026-08-04 2026-08-04 1831 已为您减免ߎ年度年ો',
  ].join('\n');

  const mail = {
    from: 'boczhangdan@bankofchina.com',
    subject: '中国银行信用卡电子账单',
    date: new Date(),
    text: '',
    pdfText,
  };

  it('按卡分节解析明细：消费为正，还款（金额=存入合计）为负，无金额行跳过', () => {
    const bills = boc2026Parser.parse(mail);
    expect(bills).toHaveLength(1);
    const bill = bills[0]!;
    expect(bill.cardLast4).toBe('1831');
    expect(bill.amount).toBeCloseTo(2861.3);
    expect(bill.transactions).toHaveLength(2);
    expect(bill.transactions![0]).toMatchObject({ date: '2026-07-14', amount: 1085 });
    // 2710.40 与节内存入(还款)合计一致 → 记负数
    expect(bill.transactions![1]).toMatchObject({ amount: -2710.4 });
    // "已为您减免本年度年费"行无金额，不入明细
  });

  it('零账单（无还款日值）：还款日 = 账单日 + 20 天推算，0 元卡正常入账', () => {
    // 实测样本：2022-05 合并账单"您本期无需还款"，摘要仅"账单日 欠款总计"两个值
    const zeroPdf = [
      '中国银行信用卡账单(2022年05月)',
      'Current FCY Total Balance Due',
      '2022-05-04 0.00',
      '6253 3811 **** 3798 0.00 0.00',
      '6259 0943 **** 7557 0.00 0.00',
    ].join('\n');
    const bills = boc2026Parser.parse({ ...mail, pdfText: zeroPdf });
    expect(bills).toHaveLength(2);
    expect(bills[0]).toMatchObject({ cardLast4: '3798', amount: 0, minAmount: 0 });
    expect(bills[1]).toMatchObject({ cardLast4: '7557', amount: 0, minAmount: 0 });
    expect(bills[0]!.statementDate.toISOString()).toBe(fromYmd('2022-05-04').toISOString());
    expect(bills[0]!.dueDate.toISOString()).toBe(fromYmd('2022-05-24').toISOString());
  });
});

describe('ceb2016Parser.parse（2016-2019 HTML 旧版模板）', () => {
  // 实测样本：光大银行信用卡电子对账单20160512（HTML 拍平，标签区与值区分行）
  const sampleText = [
    '尊敬的 张三 先生 您好!',
    '感谢您使用中国光大银行信用卡！特为您呈上2016年04月13日至2016年05月12日信用卡账户变动情况。您最晚于2016年05月31日还款，请勿错过您的到期还款日。',
    '人民币账户（单位：元）RMB Account',
    '00046242****0437872',
    '京东白条卡',
    '977.32',
    '977.32',
    '97.73',
    '总计',
    '977.32',
    '977.32',
    '97.73',
    '美元账户（单位：元）USD Account',
    '00046242****0437872',
    '京东白条卡',
    '2.99',
    '2.99',
    '0.30',
    '人民币账户交易明细（单位：元）RMB Account Details',
  ].join('\n');

  const mail = {
    from: 'cebbank@cardcenter.cebbank.com',
    subject: '光大银行信用卡电子对账单20160512',
    date: new Date(),
    text: sampleText,
  };

  it('同一卡分别解析人民币和美元账单', () => {
    const bills = ceb2016Parser.parse(mail);
    expect(bills).toHaveLength(2);
    const bill = bills.find((item) => item.currency === 'CNY')!;
    expect(bill.cardLast4).toBe('7872');
    expect(bill.holderName).toBe('张三');
    expect(bill.amount).toBeCloseTo(977.32);
    expect(bill.minAmount).toBeCloseTo(97.73);
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2016-05-12').toISOString());
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2016-05-31').toISOString());
    expect(bill.period).toBe('2016-05');
    expect(bills.find((item) => item.currency === 'USD')).toMatchObject({
      cardLast4: '7872',
      amount: 2.99,
      minAmount: 0.3,
      currency: 'USD',
    });
  });

  it('tryParse 降级链：ceb2026/ceb2019 均失败后由 ceb2016 接管', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.parserId).toBe('ceb2016');
      expect(result.bills).toHaveLength(2);
      expect(result.bills[0]?.cardLast4).toBe('7872');
    }
  });

  it('缺少引导句（账期+还款日）返回空数组', () => {
    const broken = {
      ...mail,
      text: '人民币账户（单位：元）RMB Account\n00046242****0437872\n京东白条卡\n977.32\n977.32\n97.73',
    };
    expect(ceb2016Parser.parse(broken)).toEqual([]);
  });
});

describe('cmb2020Parser.parse（2020-2021 分行摘要模板）', () => {
  // 实测样本：招商银行信用卡电子账单 2020-10（摘要与明细均分行，明细带卡尾）
  const sampleText = [
    '尊敬的 张三 先生，您好！以下是您的招商银行信用卡10月账单',
    '2020/09/09-2020/10/08',
    '￥35,000',
    '￥218.80',
    '￥10.94',
    '2020/10/26',
    '1007',
    '掌上生活还款',
    '￥- 2,500.00',
    '2111',
    '-2,500.00',
    '0816',
    '0917',
    '手机银行饭票',
    '￥- 88.00',
    '7449',
    'CN',
    '-88.00',
  ].join('\n');

  const mail = {
    from: 'ccsvc@message.cmbchina.com',
    subject: '招商银行信用卡电子账单',
    date: new Date(),
    text: sampleText,
  };

  it('分行摘要解析：金额/日期/期次，明细负数=还款、多卡尾批量副卡', () => {
    const bills = cmb2020Parser.parse(mail);
    expect(bills).toHaveLength(1);
    const bill = bills[0]!;
    expect(bill.holderName).toBe('张三');
    expect(bill.amount).toBeCloseTo(218.8);
    expect(bill.minAmount).toBeCloseTo(10.94);
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2020-10-08').toISOString());
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2020-10-26').toISOString());
    expect(bill.period).toBe('2020-10');
    // 明细：掌上生活还款 -2500（卡尾 2111）、手机银行饭票 -88（卡尾 7449，双日期行取交易日 0816）
    expect(bill.transactions).toHaveLength(2);
    expect(bill.transactions![0]).toMatchObject({ date: '1007', description: '掌上生活还款', amount: -2500, cardLast4: '2111' });
    expect(bill.transactions![1]).toMatchObject({ date: '0816', description: '手机银行饭票', amount: -88, cardLast4: '7449' });
    // 多卡尾 → 主卡取第一个 + cardLast4s 全量
    expect(bill.cardLast4).toBe('2111');
    expect(bill.cardLast4s).toEqual(['2111', '7449']);
  });

  it('补发账单：周期带"(补)"后缀，零金额仍入账', () => {
    const buMail = {
      ...mail,
      text: ['尊敬的 张三 先生，您好！以下是您的招商银行信用卡09月账单', '2020/08/09-2020/09/08(补)', '￥35,000', '￥0.00', '￥0.00', '2020/09/26'].join('\n'),
    };
    const bills = cmb2020Parser.parse(buMail);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.amount).toBe(0);
    expect(bills[0]!.statementDate.toISOString()).toBe(fromYmd('2020-09-08').toISOString());
    expect(bills[0]!.dueDate.toISOString()).toBe(fromYmd('2020-09-26').toISOString());
    // 无明细 → 保持账户级 ----
    expect(bills[0]!.cardLast4).toBe('----');
  });

  it('同发件人的非账单邮件（每日信用管家）不处理', () => {
    const daily = { ...mail, subject: '每日信用管家' };
    expect(cmb2020Parser.parse(daily)).toEqual([]);
  });

  it('招行特例：0000 后无 CN 视为没卡号，0000 后有 CN 保留卡尾', () => {
    const feeMail = {
      ...mail,
      text: [
        '尊敬的 张三 先生，您好！以下是您的招商银行信用卡02月账单',
        '2023/01/09-2023/02/08',
        '￥35,000',
        '￥136.00',
        '￥36.00',
        '2023/02/26',
        '0208',
        '会员费-增值服务使用费',
        '￥36.00',
        '0000',
        '0115',
        '商户消费',
        '￥100.00',
        '3096',
        'CN',
        '100.00',
      ].join('\n'),
    };
    const bills = cmb2020Parser.parse(feeMail);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.transactions).toEqual([
      expect.objectContaining({ description: '会员费-增值服务使用费', cardLast4: null }),
      expect.objectContaining({ description: '商户消费', cardLast4: '3096' }),
    ]);
    expect(bills[0]!.cardLast4).toBe('3096');
  });

  it('tryParse 降级链：cmb2026 单行摘要不匹配分行格式，由 cmb2020 接管', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.parserId).toBe('cmb2020');
      expect(result.bills[0]?.amount).toBeCloseTo(218.8);
    }
  });
});

describe('citic2023Parser.parse（2023 分行卡表模板）', () => {
  // 运通卡明细 8 行组：卡号后四位必须是 8855（抬头掩码末组 855 不得建档）
  const amexTxn = [
    '20230401',
    '20230401',
    '8855',
    '运通卡消费',
    'CNY',
    '100.00',
    'CNY',
    '100.00',
  ].join('\n');
  // 实测样本：中信银行信用卡电子账单 2023-04（卡表 7 行组，含运通卡抬头 855）
  const headerText = [
    '尊敬的张三先生：',
    '您好！2023年04月账单已产生，记录了您2023年03月03日-2023年04月02日账户变动信息，现为您诚意奉上，仅供您参考，',
    '到期还款日：2023年04月21日',
    '3780-09**-****-855',
    'RMB',
    '2,500.82',
    '2,500.82',
    '4,445.92',
    '4,445.92',
    '222.30',
    '6226-89**-****-6133',
    'RMB',
    '1,351.44',
    '1,351.44',
    '462.87',
    '462.87',
    '23.14',
    '6226-89**-****-6046',
    'RMB',
    '0.00',
    '0.00',
    '1,390.00',
    '1,390.00',
    '119.00',
  ].join('\n');
  const sampleText = `${headerText}\n${amexTxn}`;

  const mail = {
    from: 'citiccard@bill.citiccard.com',
    subject: '中信银行信用卡电子账单',
    date: new Date(),
    text: sampleText,
  };

  it('多卡解析：账期"-"分隔、运通卡尾取明细 8855、第 6/7 值为应还与最低', () => {
    const bills = citic2023Parser.parse(mail);
    expect(bills).toHaveLength(3);
    expect(bills[0]).toMatchObject({ cardLast4: '8855', amount: 4445.92, minAmount: 222.3 });
    expect(bills[1]).toMatchObject({ cardLast4: '6133', amount: 462.87, minAmount: 23.14 });
    expect(bills[2]).toMatchObject({ cardLast4: '6046', amount: 1390.0, minAmount: 119.0 });
    expect(bills[0]!.statementDate.toISOString()).toBe(fromYmd('2023-04-02').toISOString());
    expect(bills[0]!.dueDate.toISOString()).toBe(fromYmd('2023-04-21').toISOString());
    expect(bills[0]!.period).toBe('2023-04');
  });

  it('运通卡尾来源=明细末四位：抬头 855 不得建档，明细 8855 才建档', () => {
    const headerOnly = citic2023Parser.parse({ ...mail, text: headerText });
    expect(headerOnly.map((b) => b.cardLast4)).toEqual(['6133', '6046']);
    const bills = citic2023Parser.parse(mail);
    expect(bills.find((b) => b.cardLast4 === '8855')).toBeTruthy();
    expect(bills.find((b) => b.cardLast4 === '855')).toBeUndefined();
    expect(bills[0]!.transactions).toEqual([
      expect.objectContaining({ cardLast4: '8855', description: '运通卡消费' }),
    ]);
  });

  it('tryParse 降级链：citic2026 不匹配 2023 版，由 citic2023 接管', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.parserId).toBe('citic2023');
      expect(result.bills).toHaveLength(3);
    }
  });

  it('缺少"到期还款日"横幅返回空数组', () => {
    const broken = { ...mail, text: sampleText.replace('到期还款日：2023年04月21日\n', '') };
    expect(citic2023Parser.parse(broken)).toEqual([]);
  });

  it('空格分词账期（"您 2023年05月14日 至 2023年06月13日"）+ 冒号后空格回归', () => {
    // 实测样本：2023-06 账单（HTML 拍平后账期句含空格，4 卡含 3 位卡尾运通卡）
    const spacedText = [
      '尊敬的 张三 先生 ：',
      '感谢您使用中信银行信用卡， 2023年06月 账单已产生，记录了您 2023年05月14日 至 2023年06月13日 账户变动信息。',
      '到期还款日： 2023年07月02日',
      '6226-89**-****-6133',
      'RMB',
      '2961.70',
      '2961.70',
      '223.02',
      '223.02',
      '132.75',
      '3780-09**-****-855',
      'RMB',
      '2204.80',
      '2204.80',
      '3028.95',
      '3028.95',
      '151.45',
      '20230601',
      '20230601',
      '8855',
      '运通卡消费',
      'CNY',
      '100.00',
      'CNY',
      '100.00',
    ].join('\n');
    const bills = citic2023Parser.parse({ ...mail, text: spacedText });
    expect(bills).toHaveLength(2);
    expect(bills[0]).toMatchObject({ cardLast4: '6133', amount: 223.02, minAmount: 132.75 });
    expect(bills[1]).toMatchObject({ cardLast4: '8855', amount: 3028.95, minAmount: 151.45 });
    expect(bills[0]!.statementDate.toISOString()).toBe(fromYmd('2023-06-13').toISOString());
    expect(bills[0]!.dueDate.toISOString()).toBe(fromYmd('2023-07-02').toISOString());
  });
});

describe('ceb2019Parser.parse（2026-06 新版摘要：美元应还替代最低还款标签）', () => {
  // 实测样本：光大信用卡电子账单 2026-06-12（text 版，美元账户区块先于人民币且同卡重复）
  const newFormatText = [
    '张三  先生（收）',
    '感谢您使用中国光大银行信用卡！特为您呈上2026年05月13日至2026年06月12日的信用卡账户变化情况。',
    '您最晚于2026年07月01日还款，请勿错过您的到期还款日。',
    '账单日期',
    'Statement Date 到期还款日',
    'Payment Due Date 信用额度',
    'Credit Limit 人民币本期账单金额',
    'RMB Statement Balance 美元本期账单金额',
    'USD Statement Balance 2026/06/12 2026/07/01 ￥4,400.00 ￥804.99 $12.14',
    '美元账户  USD Account',
    '（单位：美元）',
    'Minimum Payment Due 40625406****6605 12.14 12.14 0.24',
    '人民币账户  RMB',
    'Account （单位：元）',
    'Minimum Payment Due 40625406****6605 799.00 799.00 15.98 62597602****9975',
    '(存款)110.00 0.00 0.00 62597604****9387 17.97 5.99 5.99 合计 706.97 804.99 21.97',
    '人民币账户交易明细  RMB',
    'Account Details （单位：元）',
  ].join('\n');

  const mail = {
    from: 'cebbank@cardcenter.cebbank.com',
    subject: '光大信用卡电子账单（2026年06月12日）',
    date: new Date(),
    text: newFormatText,
  };

  it('同一账户按币种汇总，保留人民币三卡套卡关系', () => {
    const bills = ceb2019Parser.parse(mail);
    expect(bills).toHaveLength(2);
    const cny = bills.find((item) => item.currency === 'CNY')!;
    expect(cny).toMatchObject({
      cardLast4: '6605',
      cardLast4s: ['6605', '9975', '9387'],
      amount: 804.99,
      minAmount: 21.97,
    });
    expect(cny.holderName).toBe('张三');
    expect(cny.statementDate.toISOString()).toBe(fromYmd('2026-06-12').toISOString());
    expect(cny.dueDate.toISOString()).toBe(fromYmd('2026-07-01').toISOString());
    expect(bills.find((item) => item.currency === 'USD')).toMatchObject({
      cardLast4: '6605',
      cardLast4s: ['6605', '9975', '9387'],
      amount: 12.14,
      minAmount: 0.24,
      currency: 'USD',
    });
  });

  it('旧版摘要（Minimum Payment Due 5 值行）回归不受影响', () => {
    const oldMail = {
      ...mail,
      subject: '光大信用卡电子账单（2023年01月12日）',
      text: [
        '张三  先生（收）',
        'RMB Minimum Payment Due 2023/01/12 2023/01/31 ￥4,400.00 ￥3,156.46 ￥157.82',
        '40625406****6605 532.24 532.24 26.61',
      ].join('\n'),
    };
    const bills = ceb2019Parser.parse(oldMail);
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ cardLast4: '6605', amount: 532.24, minAmount: 26.61 });
    expect(bills[0]!.statementDate.toISOString()).toBe(fromYmd('2023-01-12').toISOString());
    expect(bills[0]!.dueDate.toISOString()).toBe(fromYmd('2023-01-31').toISOString());
  });

  it('tryParse 降级链：ceb2026 的"账单日 Statement Date"在新版为"账单日期"不匹配，由 ceb2019 接管', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.parserId).toBe('ceb2019');
      expect(result.bills).toHaveLength(2);
    }
  });
});

describe('ceb2017Parser.parse（2017 PDF 附件模板）', () => {
  // 实测样本：光大银行信用卡电子对账单20170112（账单在 PDF 附件中，正文仅通知信）
  const pdfText = [
    '张三  先生（收）',
    '账单日',
    'Statement Date',
    '2017-01-12',
    '到期还款日',
    'Payment Due Date',
    '2017-01-31',
    '人民币本期应还款额',
    'RMB Statement Balance',
    '￥982.65',
    'Account Number : 46242700****7872 京东白条卡',
    '人民币账户交易明细  RMB Account Details （单位：元）',
    '本期最低还款额 Minimum Payment Due 49.13',
    '2016/12/17 2016/12/17 7872 网上支付 京东支付 21.90',
    '2016/12/20 2016/12/21 7872 消费退货 苏宁易购 (存入)500.00',
    '美元账户  USD Account',
    'Account Number : 46242700****7872 京东白条卡',
  ].join('\n');

  const mail = {
    from: 'cebbank@cardcenter.cebbank.com',
    subject: '光大银行信用卡电子对账单20170112',
    date: new Date(),
    pdfText,
  };

  it('PDF 附件解析：1 卡入账 + (存入)前缀明细取负 + 美元区块切片规避', () => {
    const bills = ceb2017Parser.parse(mail);
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ cardLast4: '7872', amount: 982.65, minAmount: 49.13 });
    expect(bills[0]!.holderName).toBe('张三');
    expect(bills[0]!.statementDate.toISOString()).toBe(fromYmd('2017-01-12').toISOString());
    expect(bills[0]!.dueDate.toISOString()).toBe(fromYmd('2017-01-31').toISOString());
    expect(bills[0]!.transactions).toHaveLength(2);
    expect(bills[0]!.transactions![1]).toMatchObject({ description: '消费退货 苏宁易购', amount: -500 });
  });

  it('无 PDF 附件（正文通知信）返回空，不误报', () => {
    expect(ceb2017Parser.parse({ ...mail, pdfText: undefined })).toEqual([]);
  });

  it('tryParse 降级链：ceb2026/ceb2019/ceb2016 仅认正文模板，由 ceb2017 接管 PDF 账单', () => {
    const result = tryParse(mail);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.parserId).toBe('ceb2017');
      expect(result.bills).toHaveLength(1);
    }
  });
});

describe('hnb2026Parser.parse（2022 华融湘江版：本期还款总额无"应"字）', () => {
  // 实测样本：华融湘江银行信用卡2022年03月电子账单（hrxjbank.com.cn 旧域名）
  const sampleText = [
    '尊敬的张三先生/女士： 您好！',
    '感谢您使用华融湘江银行信用卡！以下是您2022年03月的账单，请勿错过您的还款期限。',
    '账单日 ( Statement Date )',
    '2022-03-08',
    '到期还款日 ( Payment Due Date )',
    '2022-04-02',
    '本期还款总额 ( Current Balance )',
    'RMB 417.83',
    '本期最低还款额度 ( Mininum Payment )',
    'RMB 41.78',
    '本期账务明细( Transaction Details )',
    '2022-02-28',
    '2022-02-28',
    '银联跨行消费',
    '国网湖南省电力有限公司',
    '30.00',
    '1937',
    '2022-03-01',
    '2022-03-01',
    '银联跨行消费',
    '肯德基湖南长沙梅溪湖精选店',
    '15.00',
    '1937',
  ].join('\n');

  const mail = {
    from: 'creditcard@hrxjbank.com.cn',
    subject: '华融湘江银行信用卡2022年03月电子账单',
    date: new Date(),
    text: sampleText,
  };

  it('"本期还款总额"（无"应"）可解析，明细卡尾回填主卡', () => {
    const bills = hnb2026Parser.parse(mail);
    expect(bills).toHaveLength(1);
    const bill = bills[0]!;
    expect(bill.amount).toBeCloseTo(417.83);
    expect(bill.minAmount).toBeCloseTo(41.78);
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2022-03-08').toISOString());
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2022-04-02').toISOString());
    expect(bill.period).toBe('2022-03');
    expect(bill.transactions).toHaveLength(2);
    expect(bill.transactions![0]).toMatchObject({ date: '2022-02-28', amount: 30, cardLast4: '1937' });
    // 单一卡尾 → 账单归属该卡
    expect(bill.cardLast4).toBe('1937');
  });
});

describe('hxb2026Parser.parse（2022 版：人民币在前 Amount Payable + 跨行卡号还款明细）', () => {
  // 实测样本：华夏信用卡电子账单 2022-02（人民币金额在前、美元在后带 Amount Payable 后缀）
  const sampleText = [
    '尊敬的张三 先生：',
    '您好，感谢您使用本行信用卡。特别呈上您2022年02月份的对账单，请您核对并缴款。',
    '华夏信用卡对账单(2022/02)',
    '本期应还款 ￥78.00 Amount Payable $0.00',
    '最低应还款 ￥10.00 Amount Payable $0.00',
    '账单日 每月19日 Statement Date',
    '最后还款日 2022/03/11 Payment Due Date',
    '人民币账务信息 RMB ACCOUNT',
    'Trans Amount 01/27 01/27 财付通(银联云闪付)  5986 ￥78.00 02/02 02/03 银联信用卡还款',
    '6222020000000000  5986 -￥920.74',
    '美元账务信息 USD ACCOUNT',
  ].join('\n');

  const mail = {
    from: 'admin@creditcardmail.hxb.com.cn',
    subject: '华夏信用卡-电子账单2022年02月',
    date: new Date(),
    text: sampleText,
  };

  it('人民币在前金额顺序可解析，美元零账单独立保留，跨行还款取负', () => {
    const bills = hxb2026Parser.parse(mail);
    expect(bills).toHaveLength(2);
    const bill = bills.find((item) => item.currency === 'CNY')!;
    expect(bill.amount).toBeCloseTo(78);
    expect(bill.minAmount).toBeCloseTo(10);
    // 账单日为规则型"每月19日"，按账单月份 2022/02 取 19 号
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2022-02-19').toISOString());
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2022-03-11').toISOString());
    expect(bill.cardLast4).toBe('5986');
    expect(bill.transactions).toHaveLength(2);
    expect(bill.transactions![0]).toMatchObject({ date: '01/27', description: '财付通(银联云闪付)', amount: 78, cardLast4: '5986' });
    // 还款明细：摘要与完整卡号跨行，金额带负号 → 记负数
    expect(bill.transactions![1]).toMatchObject({ date: '02/02', description: '银联信用卡还款', amount: -920.74, cardLast4: '5986' });
    expect(bills.find((item) => item.currency === 'USD')).toMatchObject({
      amount: 0,
      minAmount: 0,
      currency: 'USD',
    });
  });
});

describe('pab2026Parser.parse（平安账户级账单：卡区块归属）', () => {
  // 实测模板：明细区按卡分区块，卡头行（全角括号卡尾）切换当前卡，
  // "分期 Installment" 等账户级区块无卡号 → 解析阶段留空，合账再挂优先显示卡
  const multiCardText = [
    '尊敬的张三 先生 ：',
    '感谢您使用平安信用卡，以下是您 08 月的信用卡对账单。',
    '本期应还金额',
    '￥',
    '1,756.01',
    '$',
    '0.00',
    '本期最低应还金额',
    '￥',
    '732.79',
    '本期账单日',
    '2026-08-17',
    '本期还款日',
    '2026-09-05',
    '人民币账户交易明细',
    '平安银行好车主信用卡（1765）',
    '主卡 Main Card',
    '合计：￥ 100.00',
    '2026-08-01',
    '2026-08-01',
    '加油充值',
    '￥100.00',
    '平安银行京喜白金联名信用卡（8837）',
    '合计：￥ 200.00',
    '2026-08-02',
    '2026-08-02',
    '超市购物',
    '￥200.00',
    '分期 Installment',
    '合计：￥ 50.00',
    '2026-07-15',
    '2026-07-15',
    '账单分期手续费',
    '￥50.00',
  ].join('\n');

  it('多卡区块：CNY/USD 独立账单，合并卡尾且分期卡号留空', () => {
    const bills = pab2026Parser.parse({
      from: 'creditcard@service.pingan.com',
      subject: '平安信用卡电子账单',
      date: new Date(),
      text: multiCardText,
    });
    expect(bills).toHaveLength(2);
    const bill = bills.find((item) => item.currency === 'CNY')!;
    expect(bill.amount).toBeCloseTo(1756.01);
    expect(bill.minAmount).toBeCloseTo(732.79);
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2026-08-17').toISOString());
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2026-09-05').toISOString());
    // 主卡（第一个卡区块）+ 合并卡尾
    expect(bill.cardLast4).toBe('1765');
    expect(bill.cardLast4s).toEqual(['1765', '8837']);
    expect(bill.transactions).toHaveLength(3);
    // 各交易归属：卡区块交易按卡尾；分期解析阶段留空
    expect(bill.transactions![0]).toMatchObject({ description: '加油充值', amount: 100, cardLast4: '1765' });
    expect(bill.transactions![1]).toMatchObject({ description: '超市购物', amount: 200, cardLast4: '8837' });
    expect(bill.transactions![2]).toMatchObject({ description: '账单分期手续费', amount: 50, cardLast4: null });
    expect(bills.find((item) => item.currency === 'USD')).toMatchObject({
      amount: 0,
      minAmount: 0,
      currency: 'USD',
    });
  });

  it('附卡区块姓名按卡尾写入 holderMap，不得用抬头覆盖附卡', () => {
    const text = [
      '尊敬的张三 先生 ：',
      '本期应还金额 ￥ 1,756.01 $ 0.00',
      '本期最低应还金额 ￥ 732.79 $ 0.00',
      '本期账单日 2026-08-17',
      '本期还款日 2026-09-05',
      '人民币账户交易明细',
      '平安银行好车主信用卡（1765）',
      '主卡 Main Card',
      '合计：￥ 100.00',
      '2026-08-01',
      '2026-08-01',
      '加油充值',
      '￥100.00',
      '平安银行京喜白金联名信用卡（8837）',
      '附卡 Sup Card 附卡人：王小花',
      '合计：￥ 200.00',
      '2026-08-02',
      '2026-08-02',
      '超市购物',
      '￥200.00',
    ].join('\n');
    const bills = pab2026Parser.parse({
      from: 'creditcard@service.pingan.com',
      subject: '平安信用卡电子账单',
      date: new Date(),
      text,
    });
    const bill = bills[0]!;
    expect(bill.holderName).toBe('张三');
    expect(bill.holderMap).toEqual({ '8837': '王小花' });
    expect(bill.cardLast4s).toEqual(['1765', '8837']);
  });

  it('附卡区块无附卡人时不写入该卡映射', () => {
    const text = [
      '尊敬的张三 先生 ：',
      '本期应还金额 ￥ 1,756.01 $ 0.00',
      '本期最低应还金额 ￥ 732.79 $ 0.00',
      '本期账单日 2026-08-17',
      '本期还款日 2026-09-05',
      '人民币账户交易明细',
      '平安银行好车主信用卡（1765）',
      '主卡 Main Card',
      '合计：￥ 100.00',
      '2026-08-01',
      '2026-08-01',
      '加油充值',
      '￥100.00',
      '平安银行京喜白金联名信用卡（8837）',
      '附卡 Sup Card',
      '合计：￥ 200.00',
      '2026-08-02',
      '2026-08-02',
      '超市购物',
      '￥200.00',
    ].join('\n');
    const bills = pab2026Parser.parse({
      from: 'creditcard@service.pingan.com',
      subject: '平安信用卡电子账单',
      date: new Date(),
      text,
    });
    expect(bills[0]!.holderMap).toBeUndefined();
    expect(bills[0]!.holderName).toBe('张三');
  });

  it('嵌套括号卡头（金卡）（8837）取末尾括号卡尾', () => {
    const bills = pab2026Parser.parse({
      from: 'creditcard@service.pingan.com',
      subject: '平安白金信用卡电子账单',
      date: new Date(),
      text: multiCardText.replace('平安银行京喜白金联名信用卡（8837）', '平安银行好车主卡（金卡）（8837）'),
    });
    const bill = bills[0]!;
    expect(bill.cardLast4s).toEqual(['1765', '8837']);
    expect(bill.transactions!.find((t) => t.description === '超市购物')).toMatchObject({ cardLast4: '8837' });
  });

  it('单卡区块：两个币种账单均归属该卡，无 cardLast4s', () => {
    const singleCardText = [
      '尊敬的张三 先生 ：',
      '本期应还金额 ￥ 240.95 $ 0.00',
      '本期最低应还金额 ￥ 120.47 $ 0.00',
      '本期账单日 2021-02-17',
      '本期还款日 2021-03-05',
      '人民币账户交易明细',
      '平安银行白金信用卡（4856）',
      '合计：￥ 80.00',
      '2021-02-01',
      '2021-02-01',
      '餐饮消费',
      '￥80.00',
    ].join('\n');
    const bills = pab2026Parser.parse({
      from: 'creditcard@service.pingan.com',
      subject: '平安白金信用卡电子账单',
      date: new Date(),
      text: singleCardText,
    });
    expect(bills).toHaveLength(2);
    const bill = bills.find((item) => item.currency === 'CNY')!;
    expect(bill.amount).toBeCloseTo(240.95);
    expect(bill.cardLast4).toBe('4856');
    expect(bill.cardLast4s).toBeUndefined();
    expect(bill.transactions).toHaveLength(1);
    expect(bill.transactions![0]).toMatchObject({ cardLast4: '4856' });
    expect(bills.find((item) => item.currency === 'USD')).toMatchObject({
      cardLast4: '4856',
      amount: 0,
      minAmount: 0,
      currency: 'USD',
    });
  });
});

describe('njcb2023Parser.parse（南京 N CARD 海报式账单）', () => {
  // 实测模板（2023-2025）：字段拆行散落，无卡号无明细；出账日无字段，
  // 真实卡规则为"出账日+25天=还款日"（邮件在出账日次日发送，取邮件日会晚一天）
  const sampleText = [
    '尊敬的客户，您的信用卡账单已生成。',
    '张三 先生的N Card信用卡账单',
    '2023-12',
    '415.00',
    '2024年',
    '01',
    '月',
    '06',
    '日',
    '120.70',
  ].join('\n');

  it('出账日 = 还款日 - 25 天（而非邮件发送日）', () => {
    const bills = njcb2023Parser.parse({
      from: 'cc@message.njcb.com.cn',
      subject: '南京银行N CARD账户电子账单',
      date: new Date('2023-12-13T10:00:00+08:00'),
      text: sampleText,
    });
    expect(bills).toHaveLength(1);
    const bill = bills[0]!;
    expect(bill.amount).toBeCloseTo(415);
    expect(bill.minAmount).toBeCloseTo(120.7);
    expect(bill.dueDate.toISOString()).toBe(fromYmd('2024-01-06').toISOString());
    // 还款日 2024-01-06 - 25 天 = 2023-12-12（邮件 12-13 发送，若取邮件日会晚一天）
    expect(bill.statementDate.toISOString()).toBe(fromYmd('2023-12-12').toISOString());
    expect(bill.period).toBe('2023-12');
    expect(bill.cardLast4).toBe('----');
    expect(bill.holderName).toBe('张三');
  });
});

describe('applyTransactionTails（明细卡尾归属 + 0000 占位过滤）', () => {
  function baseBill(cardLast4 = '----'): ParsedBill {
    return {
      bankName: '招商银行',
      cardLast4,
      amount: 37.8,
      currency: 'CNY',
      statementDate: fromYmd('2026-02-08'),
      dueDate: fromYmd('2026-02-26'),
      period: '2026-02',
    };
  }

  it('费用行卡尾为 null 时不进入归属（解析阶段留空）', () => {
    const bill = baseBill();
    applyTransactionTails(bill, [
      { date: '2026-01-09', description: '会员费-增值服务使用费', amount: 36.0, cardLast4: null },
      { date: '2026-01-16', description: '支付宝-京动力咖啡', amount: 13.0, cardLast4: '3096' },
    ]);
    expect(bill.cardLast4).toBe('3096');
    expect(bill.cardLast4s).toBeUndefined();
    expect(bill.transactions).toHaveLength(2);
  });

  it('0000 占位与真实卡尾并存 → 剔除 0000 归属真实卡（招行会员费行）', () => {
    const bill = baseBill();
    const txns: ParsedTransaction[] = [
      { date: '2026-01-09', description: '会员费-增值服务使用费', amount: 36.0, cardLast4: '0000' },
      { date: '2026-01-16', description: '支付宝-京动力咖啡', amount: 13.0, cardLast4: '3096' },
      { date: '2026-01-30', description: '支付宝-某百货商行', amount: 1.0, cardLast4: '3096' },
    ];
    applyTransactionTails(bill, txns);
    expect(bill.cardLast4).toBe('3096');
    expect(bill.cardLast4s).toBeUndefined();
    // 交易行本身保留展示（含 0000 占位行）
    expect(bill.transactions).toHaveLength(3);
  });

  it('全部 0000（浦发等无卡号邮件）→ 保留 ---- 档案占位不误写成 0000', () => {
    const bill = baseBill();
    const txns: ParsedTransaction[] = [
      { date: '2026-01-09', description: '某交易', amount: 50, cardLast4: '0000' },
      { date: '2026-01-16', description: '某交易2', amount: 50, cardLast4: '0000' },
    ];
    applyTransactionTails(bill, txns);
    expect(bill.cardLast4).toBe('----');
    expect(bill.cardLast4s).toBeUndefined();
  });

  it('多真实卡尾 → 合并账单（主卡 + cardLast4s）', () => {
    const bill = baseBill();
    const txns: ParsedTransaction[] = [
      { date: '2026-08-01', description: '主卡消费', amount: 100, cardLast4: '1765' },
      { date: '2026-08-02', description: '副卡消费', amount: 200, cardLast4: '8837' },
    ];
    applyTransactionTails(bill, txns);
    expect(bill.cardLast4).toBe('1765');
    expect(bill.cardLast4s).toEqual(['1765', '8837']);
  });

  it('明细无卡尾 → 保持账单原有 cardLast4', () => {
    const bill = baseBill('3096');
    applyTransactionTails(bill, [{ date: '2026-01-16', description: '某交易', amount: 13 }]);
    expect(bill.cardLast4).toBe('3096');
    expect(bill.transactions).toHaveLength(1);
  });
});
