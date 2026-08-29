/**
 * 营销邮件黑名单：纯营销/通知域名直接忽略（不拉正文、不解析、不计错误）。
 * 只收确认无账单的营销域名，绝不包含 message.cmbchina.com 等真实账单发件域，
 * 防止误杀账单邮件。
 * 命中后 MailLog 记 status='unmatched'，与解析器未命中邮件同口径；不拉正文、不解析、不计错误。
 */
const BLACKLIST_DOMAINS = [
  // 众邦银行营销系（407 封实测）
  'service.bank.za.group',
  'mail.za.group',
  'mail.bank.za.group',
  // 汇立银行营销系（78 封实测）
  'marketing.welab.bank',
  'welab.bank',
  'service.welab.bank',
  // 天星银行通知系（40 封实测）
  'notification.airstarbank.com',
  'vb.airstarbank.com',
  // 蚂蚁银行通知系（28 封实测）
  'notify.antbank.hk',
  // 富藤银行通知系（14 封实测）
  'notification.elebank.com',
  'vb.elebank.com',
];

/**
 * 发件人地址是否命中黑名单（域名精确或子域后缀匹配）。
 * 入参为 envelope 拼接的纯地址串（多地址以逗号分隔）。
 */
export function isBlacklisted(from: string): boolean {
  return from
    .toLowerCase()
    .split(',')
    .some((addr) => {
      const at = addr.lastIndexOf('@');
      if (at < 0) return false;
      const domain = addr.slice(at + 1).trim();
      return BLACKLIST_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
    });
}
