import type { ImapFlow } from 'imapflow';
import { ApiError } from '../../lib/errors';

export const MAX_MAIL_SOURCE_BYTES = 32 * 1024 * 1024;

export class MailSourceLimitError extends ApiError {
  constructor() { super(413, '邮件原文超过 32 MiB，已停止读取'); }
}

/** 在 IMAP 端限制正文读取长度，不标记已读；超限邮件不得截断后继续解析。 */
export async function readMailSource(client: ImapFlow, uid: number, envelope = false) {
  const message = await client.fetchOne(uid, {
    uid: true, size: true, ...(envelope ? { envelope: true } : {}), source: { maxLength: MAX_MAIL_SOURCE_BYTES + 1 },
  }, { uid: true });
  if (message && ((message.size ?? 0) > MAX_MAIL_SOURCE_BYTES || (message.source?.length ?? 0) > MAX_MAIL_SOURCE_BYTES)) {
    throw new MailSourceLimitError();
  }
  return message;
}
