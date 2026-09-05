import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useBlocker } from 'react-router';
import { Button, Modal, Space } from 'antd';
import { Popup } from 'antd-mobile';
import { useResponsive } from '../responsive';

const dirtyForms = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => dirtyForms.size > 0;
function emit() { listeners.forEach(listener => listener()); }

export function useDraftGuard(dirty: boolean) {
  const id = useId();
  useEffect(() => {
    if (dirty) dirtyForms.add(id); else dirtyForms.delete(id); emit();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { dirtyForms.delete(id); emit(); window.removeEventListener('beforeunload', beforeUnload); };
  }, [dirty, id]);
}

export function NavigationGuard() {
  const dirty = useSyncExternalStore(subscribe, snapshot, () => false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const { isMobile } = useResponsive();
  if (blocker.state !== 'blocked') return null;
  const buttons = <Space><Button onClick={() => blocker.reset()}>继续编辑</Button><Button danger onClick={() => blocker.proceed()}>放弃修改并离开</Button></Space>;
  return isMobile ? <Popup visible onMaskClick={() => blocker.reset()} bodyClassName="draft-confirm-sheet"><section role="dialog" aria-modal="true" aria-label="未保存的修改"><h3>有未保存的修改</h3><p>离开后，本次修改不会保存。</p>{buttons}</section></Popup> : <Modal open title="有未保存的修改" aria-label="有未保存的修改" onCancel={() => blocker.reset()} footer={buttons}><p>离开后，本次修改不会保存。</p></Modal>;
}

/** 金额等局部编辑退出时复用相同确认；只登记脏状态，不保存输入内容。 */
export function useUnsavedExit(dirty: boolean, onExit: () => void, busy = false) {
  const [confirming, setConfirming] = useState(false);
  const { isMobile } = useResponsive();
  useDraftGuard(dirty);
  const requestExit = () => { if (!busy) { if (dirty) setConfirming(true); else onExit(); } };
  const buttons = <Space><Button onClick={() => setConfirming(false)}>继续编辑</Button><Button danger onClick={() => { setConfirming(false); onExit(); }}>放弃修改</Button></Space>;
  const confirmation = !confirming ? null : isMobile
    ? <Popup visible onMaskClick={() => setConfirming(false)} bodyClassName="draft-confirm-sheet"><section role="dialog" aria-label="未保存的修改"><h3>有未保存的修改</h3><p>退出后，本次填写的金额不会保存。</p>{buttons}</section></Popup>
    : <Modal open title="有未保存的修改" onCancel={() => setConfirming(false)} footer={buttons}><p>退出后，本次填写的金额不会保存。</p></Modal>;
  return { requestExit, confirmation };
}
