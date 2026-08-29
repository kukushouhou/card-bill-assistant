// 临时验证脚本：用调研保存的真实邮件跑全部解析器（用完即删）
import fs from 'node:fs';
import { matchParser, tryParse } from '../src/parsers/registry';
import type { MailContext } from '../src/parsers/types';

const dir = 'f:/JavaScript/到期提醒助手/.trae/research';
const files = fs.readdirSync(dir).filter((f) => /^mail-\d+\.json$/.test(f)).sort();

// 已知非账单邮件（招行每日推送：额度/积分/消费明细，不含月度账单），白名单未命中为正确行为
const nonBillUids = new Set([1320912441]);

let pass = 0;
let fail = 0;
let skip = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  if (nonBillUids.has(j.uid)) {
    skip++;
    console.log(`\n[SKIP] ${j.subject}（非账单邮件，白名单未命中符合预期）`);
    continue;
  }
  const mail: MailContext = {
    from: j.from,
    subject: j.subject,
    date: new Date(j.date),
    text: j.text || undefined,
    html: j.html || undefined,
  };
  if (j.uid === 1320912331) mail.pdfText = fs.readFileSync(`${dir}/boc-pdf.txt`, 'utf8');

  const match = matchParser(j.from, j.subject);
  const result = tryParse(mail);
  const parserId = match?.parser.id ?? '(未命中)';
  const bills = result.matched ? result.bills : [];
  const ok = result.matched && bills.length > 0;
  if (ok) pass++;
  else fail++;
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${j.subject}`);
  console.log(`  uid=${j.uid} from=${j.from} parser=${parserId} bills=${bills.length}${result.matched && result.error ? ` error=${result.error}` : ''}`);
  for (const b of bills) {
    console.log(
      `    - ${b.bankName} ****${b.cardLast4} 应还${b.amount} 最低${b.minAmount ?? '-'} 出账${b.statementDate.toISOString().slice(0, 10)} 还款${b.dueDate.toISOString().slice(0, 10)} 期次${b.period}${b.holderName ? ` 持卡人=${b.holderName}` : ''}`,
    );
  }
}
console.log(`\n===== ${pass} pass, ${fail} fail, ${skip} skip =====`);
