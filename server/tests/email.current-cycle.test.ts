import { describe, expect, it } from 'vitest';
import { shouldFetchCurrentCycleMail } from '../src/modules/email/email.service';
import { fromYmd } from '../src/lib/dates';

describe('招商日度邮件当前账期门禁', () => {
  it('历史拉取始终不直接读取日度邮件正文', () => {
    expect(shouldFetchCurrentCycleMail({
      history: true,
      lastUid: 100,
      statementDate: fromYmd('2026-08-08'),
      mailDate: fromYmd('2026-08-24'),
    })).toBe(false);
  });

  it('有正式账单边界时只允许其后的日度邮件进入候选', () => {
    const statementDate = fromYmd('2026-08-08');
    expect(shouldFetchCurrentCycleMail({
      history: false,
      lastUid: 100,
      statementDate,
      mailDate: fromYmd('2026-08-07'),
    })).toBe(false);
    expect(shouldFetchCurrentCycleMail({
      history: false,
      lastUid: 100,
      statementDate,
      mailDate: fromYmd('2026-08-10'),
    })).toBe(true);
  });

  it('没有正式账单时首次回看不猜历史，建立同步游标后允许新邮件', () => {
    expect(shouldFetchCurrentCycleMail({
      history: false,
      lastUid: 0,
      statementDate: null,
      mailDate: fromYmd('2026-08-24'),
    })).toBe(false);
    expect(shouldFetchCurrentCycleMail({
      history: false,
      lastUid: 100,
      statementDate: null,
      mailDate: fromYmd('2026-08-24'),
    })).toBe(true);
  });
});
