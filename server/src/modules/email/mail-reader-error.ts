/** 只有确认整个邮箱连接不可用，迁移才中断并要求用户重新配置邮箱。 */
export class MailboxUnavailableError extends Error {
  constructor() {
    super('邮箱无法读取，请重新设置邮箱后继续');
    this.name = 'MailboxUnavailableError';
  }
}
