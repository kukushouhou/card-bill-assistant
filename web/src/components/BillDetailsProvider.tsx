import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Spin } from 'antd';
import { useLocation } from 'react-router';
import { useResponsive } from '../responsive';

const TransactionsContent = lazy(() => import('../pages/Transactions').then(module => ({ default: module.TransactionsContent })));
type BillDestination = number | { cardId: number };
type OpenDetails = (target: BillDestination, onPaid?: () => void) => void;
const BillDetailsContext = createContext<OpenDetails | null>(null);

export function useBillDetails() { return useContext(BillDetailsContext); }

/** 挂在来源列表之外，还款后即使待办行消失，明细仍留在原处。 */
export function BillDetailsProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { isMobile } = useResponsive();
  const sequence = useRef(0);
  const [detail, setDetail] = useState<{ key: number; params: URLSearchParams; sourceCardId?: number; onPaid?: () => void } | null>(null);
  const [paymentActive, setPaymentActive] = useState(false);
  const open = useCallback<OpenDetails>((target, onPaid) => {
    setDetail({ key: ++sequence.current, onPaid,
      params: new URLSearchParams(typeof target === 'number' ? { billId: String(target) } : { cardId: String(target.cardId) }),
      sourceCardId: typeof target === 'number' ? undefined : target.cardId });
  }, []);
  useEffect(() => { setDetail(null); }, [location.key]);
  // 窗口缩窄后回到来源的手机布局；正在操作还款时先由还款流程处理退出。
  useEffect(() => { if (isMobile && !paymentActive) setDetail(null); }, [isMobile, paymentActive]);
  const close = () => { if (!paymentActive) setDetail(null); };

  return <BillDetailsContext.Provider value={open}>
    {children}
    <Modal open={detail !== null} title="账单明细" className="transaction-details-modal"
      width="min(1200px, 94vw)" style={{ top: 40 }} zIndex={1200} getContainer={false}
      footer={null} destroyOnHidden onCancel={close} closable={!paymentActive}
      keyboard={!paymentActive} mask={{ closable: !paymentActive }}
      styles={{ body: { maxHeight: 'calc(100dvh - 160px)', overflowY: 'auto' } }}>
      {detail && <Suspense fallback={<Spin />}>
        <TransactionsContent key={detail.key} params={detail.params} sourceCardId={detail.sourceCardId}
          onParamsChange={params => setDetail(current => current ? { ...current, params } : null)}
          onPaid={detail.onPaid} onPaymentActiveChange={setPaymentActive} />
      </Suspense>}
    </Modal>
  </BillDetailsContext.Provider>;
}
