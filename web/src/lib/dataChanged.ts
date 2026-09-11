import { useEffect, useRef } from 'react';

const EVENT = 'app:data-changed';

/**
 * 全局业务数据已变化（升级迁移落库、跨页面流程写库等），
 * 所有挂载中的业务页面应重新加载，不得继续展示变更前的数据。
 */
export function notifyDataChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** 订阅全局数据变化；组件卸载自动取消订阅，回调引用始终取最新。 */
export function useDataChanged(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = () => ref.current();
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
