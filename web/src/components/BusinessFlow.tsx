import type { ReactNode } from 'react';
import { Modal } from 'antd';
import { useResponsive } from '../responsive';
import { MobileFlow } from './MobilePrimitives';

/** 同一业务状态，桌面分区弹窗与手机全屏两种呈现。 */
export default function BusinessFlow({ title, children, onClose, footer, width = 1080 }: {
  title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number;
}) {
  const { isMobile } = useResponsive();
  return isMobile
    ? <MobileFlow title={title} onBack={onClose} footer={footer}>{children}</MobileFlow>
    : <Modal open title={title} aria-label={title} onCancel={onClose} footer={footer ?? null} width={'min(' + width + 'px, 94vw)'} className="business-flow">{children}</Modal>;
}
