import { useLocation, useNavigate } from 'react-router';
import { useLayoutEffect } from 'react';
import { useMobileFlowNavigation } from '../components/MobilePrimitives';
import type { BillRow } from '../api/types';
import type { MarkPaidTarget } from '../components/MarkPaidModal';

const sourceSnapshots = new Map<string, unknown>();
/** 只登记筛选与展开状态，禁止登记卡片明文、PIN 或表单内容。 */
export function useSourceSnapshot(snapshot: unknown) {
  const location = useLocation();
  useLayoutEffect(() => {
    sourceSnapshots.set(location.pathname, snapshot);
    return () => { sourceSnapshots.delete(location.pathname); };
  }, [location.pathname, snapshot]);
}

export function paymentTarget(row: BillRow): MarkPaidTarget {
  if (row.recordType === 'custom') return {
    targetType: 'custom', occurrenceId: row.customOccurrenceId ?? undefined,
    businessType: row.customBusinessType ?? undefined, name: row.customName ?? undefined,
    cardId: 0, bankName: row.customName ?? '', cardLast4: '', period: row.period,
    currency: row.currency, amount: row.amount, paidStatus: row.paidStatus,
  };
  return {
    cardId: row.cardId!, bankName: row.bankName!, cardLast4: row.cardLast4!,
    period: row.period, currency: row.currency,
    billId: row.missing ? undefined : row.id ?? undefined,
    amount: row.amount, minAmount: row.minAmount, paidStatus: row.paidStatus, paidAmount: row.paidAmount,
  };
}

export function useBillNavigation() {
  const location = useLocation();
  const navigate = useMobileFlowNavigation();
  return (billId: number) => {
    const state = { ...location.state, sourceSnapshot: sourceSnapshots.get(location.pathname), sourceScrollTop: document.getElementById('root')?.scrollTop || window.scrollY };
    // 同时保存到原浏览器记录，让浏览器返回与页面内返回使用相同来源。
    window.history.replaceState({ ...window.history.state, usr: state }, '');
    navigate('/transactions?billId=' + billId, { state: { billSource: { path: location.pathname + location.search, state } } });
  };
}

export function useSourceReturn() {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    const source = location.state?.billSource;
    if (source && typeof source.path === 'string' && /^\/(bills|cards|)(\?|$)/.test(source.path)) {
      navigate(source.path, { replace: true, state: source.state });
    } else navigate('/bills');
  };
}
