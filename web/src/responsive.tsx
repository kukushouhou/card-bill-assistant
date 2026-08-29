import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';

export const MOBILE_BREAKPOINT = 1024;
export type ResponsiveMode = 'mobile' | 'desktop';

// 使用范围语法覆盖 1023.x 这类小数 CSS 视口；1024px 本身仍明确属于桌面端。
const MOBILE_QUERY = `(width < ${MOBILE_BREAKPOINT}px)`;

interface ResponsiveValue {
  isMobile: boolean;
  mode: ResponsiveMode;
}

const ResponsiveContext = createContext<ResponsiveValue | null>(null);

function subscribe(listener: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

/** 全站唯一的 1024px 响应事实源；宽度变化不重启应用或路由。 */
export function ResponsiveProvider({ children }: { children: ReactNode }) {
  const isMobile = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = useMemo<ResponsiveValue>(
    () => ({ isMobile, mode: isMobile ? 'mobile' : 'desktop' }),
    [isMobile],
  );

  return <ResponsiveContext.Provider value={value}>{children}</ResponsiveContext.Provider>;
}

export function useResponsive() {
  const value = useContext(ResponsiveContext);
  if (!value) throw new Error('useResponsive 必须在 ResponsiveProvider 内使用');
  return value;
}

/** PIN、明文和危险确认等状态可复用此钩子在跨断点时同步清理。 */
export function useResetOnModeChange(reset: () => void) {
  const { mode } = useResponsive();
  const previous = useRef(mode);
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useLayoutEffect(() => {
    if (previous.current !== mode) {
      previous.current = mode;
      resetRef.current();
    }
  }, [mode]);
}
