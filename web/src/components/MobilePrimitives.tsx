import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Button, Card, Typography } from 'antd';
import { PullToRefresh } from 'antd-mobile';
import { useResponsive } from '../responsive';

export interface MobileFlowMeta {
  id: string;
  title: string;
  onBack: () => void;
  returnPathname: string;
  returnLocation: string;
  returnScrollTop: number;
}

export interface MobileFlowNavigationOptions {
  replace?: boolean;
  state?: unknown;
}

interface MobileShellValue {
  flow: MobileFlowMeta | null;
  registerFlow: (flow: MobileFlowMeta) => () => void;
  navigateFromFlow: (to: string, options?: MobileFlowNavigationOptions) => void;
}

export const MobileShellContext = createContext<MobileShellValue | null>(null);

export function useMobileShell() {
  const value = useContext(MobileShellContext);
  if (!value) throw new Error('useMobileShell 必须在应用壳层内使用');
  return value;
}

/** 从手机子流程跳往其他路由时，先释放同页 history 槽位，避免返回时多走一层。 */
export function useMobileFlowNavigation() {
  return useMobileShell().navigateFromFlow;
}

/** 手机临时子流程：不创建稳定子路由，也不使用 Modal。 */
export function MobileFlow({
  title,
  onBack,
  children,
  footer,
  className,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const { registerFlow, flow } = useMobileShell();
  const screen = useRef<HTMLElement>(null);
  const onBackRef = useRef(onBack);
  const returnOrigin = useRef<{ pathname: string; location: string; scrollTop: number } | null>(null);
  if (returnOrigin.current == null && typeof window !== 'undefined') {
    returnOrigin.current = {
      pathname: window.location.pathname,
      location: `${window.location.pathname}${window.location.search}`,
      scrollTop: document.getElementById('root')?.scrollTop ?? 0,
    };
  }
  onBackRef.current = onBack;
  const stableBack = useCallback(() => onBackRef.current(), []);

  useLayoutEffect(() => registerFlow({
    id,
    title,
    onBack: stableBack,
    returnPathname: returnOrigin.current?.pathname ?? '',
    returnLocation: returnOrigin.current?.location ?? '',
    returnScrollTop: returnOrigin.current?.scrollTop ?? 0,
  }), [id, registerFlow, stableBack, title]);

  useLayoutEffect(() => {
    if (flow?.id !== id || !screen.current) return;
    const boundary = screen.current.closest('.route-outlet');
    if (!boundary) return;
    const hidden: Array<{ element: HTMLElement; inert: boolean; aria: string | null }> = [];
    let node: Element | null = screen.current;
    // 全屏流程保留来源 DOM 状态，同时让背景和下层流程退出触控、键盘与读屏范围。
    while (node?.parentElement && node !== boundary) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          hidden.push({ element: sibling, inert: sibling.inert, aria: sibling.getAttribute('aria-hidden') });
          sibling.inert = true; sibling.setAttribute('aria-hidden', 'true');
        }
      }
      node = node.parentElement;
    }
    return () => hidden.forEach(({ element, inert, aria }) => { element.inert = inert; if (aria == null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', aria); });
  }, [flow?.id, id]);

  return (
    <section ref={screen} className={`mobile-flow-screen ${className ?? ''}`.trim()} aria-label={title}>
      <div className="mobile-flow-body">{children}</div>
      {footer && <div className="mobile-flow-footer">{footer}</div>}
    </section>
  );
}

/** 手机下拉刷新只改变入口；在途读取由调用方的同一业务加载函数承接。 */
export function MobilePullToRefresh({
  onRefresh,
  children,
  disabled = false,
}: {
  onRefresh: () => Promise<unknown> | unknown;
  children: ReactNode;
  disabled?: boolean;
}) {
  const { isMobile } = useResponsive();
  const inFlight = useRef<Promise<unknown> | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    setRefreshFailed(false);
    const pending = Promise.resolve(onRefresh())
      .catch(() => {
        setRefreshFailed(true);
      })
      .finally(() => {
        if (inFlight.current === pending) inFlight.current = null;
      });
    inFlight.current = pending;
    return pending;
  }, [onRefresh]);

  if (!isMobile) return <>{children}</>;

  return (
    <PullToRefresh
      onRefresh={refresh}
      disabled={disabled}
      pullingText="下拉刷新"
      canReleaseText="松开刷新"
      refreshingText="正在刷新"
      completeText="已完成"
      renderText={(status) => {
        if (status === 'pulling') return '下拉刷新';
        if (status === 'canRelease') return '松开刷新';
        if (status === 'refreshing') return '正在刷新';
        return refreshFailed ? '部分失败' : '已完成';
      }}
    >
      <div className="mobile-refresh-surface">{children}</div>
    </PullToRefresh>
  );
}

export interface CoalescedRefreshOptions {
  /** 写入后需要确定读到新状态时，在已有读取结束后合并补一次读取。 */
  freshAfterInFlight?: boolean;
}

/** 为页面读函数提供同范围在途复用，并可精确合并写后的 trailing 读取。 */
export function useCoalescedRefresh<T>(loader: () => Promise<T>) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const inFlight = useRef<Promise<T> | null>(null);
  const trailing = useRef<Promise<T> | null>(null);
  const trailingBase = useRef<Promise<T> | null>(null);

  const start = useCallback(() => {
    const pending = Promise.resolve()
      .then(() => loaderRef.current())
      .finally(() => {
        if (inFlight.current === pending) inFlight.current = null;
      });
    inFlight.current = pending;
    return pending;
  }, []);

  return useCallback((options?: CoalescedRefreshOptions) => {
    const current = inFlight.current;
    // base 刚结束到 queued trailing 开始之间也可能有 Promise 微任务插入；此窗口仍复用即将开始的读。
    if (!current) return trailing.current ?? start();
    if (!options?.freshAfterInFlight) return current;

    // 所有要求“在当前读之后取新”的调用共享同一笔 trailing loader。
    if (trailing.current && trailingBase.current === current) return trailing.current;
    const base = current;
    const runTrailing = () => {
      // B 已经成为新的 in-flight 后，针对 B 发生的后续写入仍可排队 C。
      if (trailingBase.current === base) {
        trailingBase.current = null;
        trailing.current = null;
      }
      return start();
    };
    const pending = current.then(runTrailing, runTrailing).finally(() => {
      if (trailing.current === pending) {
        trailing.current = null;
        trailingBase.current = null;
      }
    });
    trailing.current = pending;
    trailingBase.current = base;
    return pending;
  }, [start]);
}

/** 手机危险操作的页内二次确认，不使用确认气泡或遮罩。 */
export function InlineConfirm({
  title,
  description,
  confirmText,
  onConfirm,
  onCancel,
  loading = false,
  danger = true,
}: {
  title: string;
  description: ReactNode;
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  danger?: boolean;
}) {
  return (
    <Card className="mobile-inline-confirm" size="small">
      <Alert type={danger ? 'error' : 'warning'} showIcon title={title} description={description} />
      <div className="mobile-inline-confirm-actions">
        <Button block disabled={loading} onClick={onCancel}>
          取消
        </Button>
        <Button type="primary" danger={danger} block loading={loading} disabled={loading} onClick={onConfirm}>
          {confirmText}
        </Button>
      </div>
    </Card>
  );
}

export function MobileEmpty({ title, description }: { title: string; description?: ReactNode }) {
  const content = useMemo(
    () => (
      <div className="mobile-empty">
        <Typography.Title level={5}>{title}</Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </div>
    ),
    [description, title],
  );
  return content;
}
