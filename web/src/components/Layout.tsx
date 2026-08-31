import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router';
import { Menu, Typography, Button, App, Tag } from 'antd';
import { List, TabBar } from 'antd-mobile';
import {
  DashboardOutlined,
  CreditCardOutlined,
  FileTextOutlined,
  ProfileOutlined,
  BellOutlined,
  MailOutlined,
  ExperimentOutlined,
  SettingOutlined,
  LogoutOutlined,
  AppstoreOutlined,
  LoadingOutlined,
  LeftOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import { useAppName } from '../appName';
import { useResponsive } from '../responsive';
import { useHistoryGate } from '../historyGate';
import UpgradePrompt from './UpgradePrompt';
import {
  MobileShellContext,
  type MobileFlowMeta,
  type MobileFlowNavigationOptions,
} from './MobilePrimitives';

export const APP_MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘', mobileLabel: '首页' },
  { key: '/cards', icon: <CreditCardOutlined />, label: '卡片管理', mobileLabel: '卡片' },
  { key: '/bills', icon: <FileTextOutlined />, label: '账单记录', mobileLabel: '账单' },
  { key: '/transactions', icon: <ProfileOutlined />, label: '账单明细', mobileLabel: '明细' },
  { key: '/reminders', icon: <BellOutlined />, label: '提醒中心', mobileLabel: '提醒' },
  { key: '/email', icon: <MailOutlined />, label: '邮箱绑定', mobileLabel: '邮箱' },
  { key: '/parsers', icon: <ExperimentOutlined />, label: '解析器中心', mobileLabel: '解析器' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置', mobileLabel: '设置' },
];

/** AntD Menu 会把未知字段透传到 DOM；桌面菜单只传其支持的字段。 */
const DESKTOP_MENU_ITEMS = APP_MENU.map(({ key, icon, label }) => ({ key, icon, label }));

const MOBILE_MAIN_KEYS = new Set(['/', '/cards', '/bills', '/reminders']);
const MOBILE_FLOW_HISTORY_KEY = '__mobileFlow';

interface FlowReturnOrigin {
  pathname: string;
  location: string;
  scrollTop: number;
  navigationEpoch: number;
}

interface PendingFlowNavigation {
  to: string;
  options?: MobileFlowNavigationOptions;
}

function currentHistoryState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state != null && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
}

function routeKey(pathname: string) {
  const first = '/' + (pathname.split('/')[1] ?? '');
  return first === '/' ? '/' : first;
}

function routeTitle(pathname: string) {
  const key = routeKey(pathname);
  return APP_MENU.find((item) => item.key === key)?.label ?? '守候';
}

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();
  const appName = useAppName();
  const { isMobile } = useResponsive();
  const historyGate = useHistoryGate();
  const [flow, setFlow] = useState<MobileFlowMeta | null>(null);
  const flowRegistry = useRef(new Map<string, MobileFlowMeta>());
  const navigationIdentity = `${location.key}|${location.pathname}|${location.search}`;
  const navigationIdentityRef = useRef(navigationIdentity);
  const navigationEpoch = useRef(0);
  if (navigationIdentityRef.current !== navigationIdentity) {
    navigationIdentityRef.current = navigationIdentity;
    navigationEpoch.current += 1;
  }
  const flowReturnOrigin = useRef<FlowReturnOrigin | null>(null);
  const pendingInteractionOrigin = useRef<{ location: string; scrollTop: number; at: number } | null>(null);
  const flowRestoreFrame = useRef<number | null>(null);
  const flowRestoreTimers = useRef<number[]>([]);
  const pendingFlowNavigation = useRef<PendingFlowNavigation | null>(null);
  const pendingFlowNavigationGuardTimer = useRef<number | null>(null);
  const flowRef = useRef<MobileFlowMeta | null>(flow);
  const isMobileRef = useRef(isMobile);
  const flowHistoryMarker = useRef(
    `mobile-flow-slot:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
  );
  const historyReady = useRef(false);
  const historySlotActive = useRef(false);
  const historyReleaseInProgress = useRef(false);
  const historyReleaseTimer = useRef<number | null>(null);
  const historyReleaseFallbackTimer = useRef<number | null>(null);
  const historyRecoveryTimer = useRef<number | null>(null);
  const staleHistoryRecoveryInProgress = useRef(false);
  const staleHistoryRecoveryFallbackTimer = useRef<number | null>(null);
  const [outletReady, setOutletReady] = useState(
    () => !Object.prototype.hasOwnProperty.call(currentHistoryState(), MOBILE_FLOW_HISTORY_KEY),
  );
  flowRef.current = flow;
  isMobileRef.current = isMobile;

  const cancelFlowOriginRestore = useCallback(() => {
    if (flowRestoreFrame.current != null) window.cancelAnimationFrame(flowRestoreFrame.current);
    flowRestoreTimers.current.forEach((timer) => window.clearTimeout(timer));
    flowRestoreFrame.current = null;
    flowRestoreTimers.current = [];
  }, []);

  const restoreFlowOrigin = useCallback(() => {
    const origin = flowReturnOrigin.current;
    if (!origin) return;
    const matchesOrigin = () => (
      navigationEpoch.current === origin.navigationEpoch
      && window.location.pathname === origin.pathname
      && `${window.location.pathname}${window.location.search}` === origin.location
    );
    if (!matchesOrigin()) {
      flowReturnOrigin.current = null;
      return;
    }

    cancelFlowOriginRestore();

    const restore = () => {
      // 每次真正写入前都复核路径与导航代次；旧路由留下的 rAF/timeout 永远不能写新页。
      if (!matchesOrigin()) {
        if (flowReturnOrigin.current === origin) flowReturnOrigin.current = null;
        return;
      }
      if (flowReturnOrigin.current !== origin || flowRegistry.current.size > 0) return;
      const root = document.getElementById('root');
      if (root) root.scrollTop = origin.scrollTop;
    };
    flowRestoreFrame.current = window.requestAnimationFrame(() => {
      flowRestoreFrame.current = null;
      restore();
    });
    flowRestoreTimers.current = [
      window.setTimeout(restore, 60),
      window.setTimeout(() => {
        restore();
        if (
          flowReturnOrigin.current === origin
          && flowRegistry.current.size === 0
          && !historyReleaseInProgress.current
          && !historySlotActive.current
        ) {
          flowReturnOrigin.current = null;
        }
        flowRestoreTimers.current = [];
      }, 280),
    ];
  }, [cancelFlowOriginRestore]);

  const finishPendingFlowNavigation = useCallback((replaceCurrent = false) => {
    const pending = pendingFlowNavigation.current;
    if (!pending) return false;
    pendingFlowNavigation.current = null;
    if (pendingFlowNavigationGuardTimer.current != null) {
      window.clearTimeout(pendingFlowNavigationGuardTimer.current);
      pendingFlowNavigationGuardTimer.current = null;
    }
    cancelFlowOriginRestore();
    flowReturnOrigin.current = null;
    pendingInteractionOrigin.current = null;
    navigate(pending.to, {
      ...pending.options,
      replace: replaceCurrent || pending.options?.replace,
    });
    return true;
  }, [cancelFlowOriginRestore, navigate]);

  const ensureFlowHistorySlot = useCallback(() => {
    if (!historyReady.current || !isMobileRef.current || !flowRef.current) return;
    const state = currentHistoryState();
    const marker = flowHistoryMarker.current;
    if (state[MOBILE_FLOW_HISTORY_KEY] === marker) {
      historySlotActive.current = true;
      return;
    }

    const next = { ...state, [MOBILE_FLOW_HISTORY_KEY]: marker };
    if (Object.prototype.hasOwnProperty.call(state, MOBILE_FLOW_HISTORY_KEY)) {
      // HMR/异常中断留下的旧 marker 也只占用这一个槽位。
      window.history.replaceState(next, '', window.location.href);
    } else {
      window.history.pushState(next, '', window.location.href);
    }
    historySlotActive.current = true;
  }, []);

  const scheduleHistoryRecovery = useCallback(() => {
    if (historyRecoveryTimer.current != null) return;
    historyRecoveryTimer.current = window.setTimeout(() => {
      historyRecoveryTimer.current = null;
      ensureFlowHistorySlot();
    }, 0);
  }, [ensureFlowHistorySlot]);

  const releaseFlowHistorySlot = useCallback(() => {
    const state = currentHistoryState();
    if (state[MOBILE_FLOW_HISTORY_KEY] !== flowHistoryMarker.current) {
      historySlotActive.current = false;
      if (!finishPendingFlowNavigation()) restoreFlowOrigin();
      return;
    }

    historyReleaseInProgress.current = true;
    historySlotActive.current = false;
    window.history.back();

    // pushState 正常一定有前一项；仍保留降级收口，避免浏览器拒绝 back 后留下 marker。
    historyReleaseFallbackTimer.current = window.setTimeout(() => {
      historyReleaseFallbackTimer.current = null;
      if (!historyReleaseInProgress.current) return;
      historyReleaseInProgress.current = false;
      const stalledState = currentHistoryState();
      if (stalledState[MOBILE_FLOW_HISTORY_KEY] === flowHistoryMarker.current) {
        const next = { ...stalledState };
        delete next[MOBILE_FLOW_HISTORY_KEY];
        window.history.replaceState(next, '', window.location.href);
      }
      // back 被浏览器拒绝时当前项仍是 marker：用 replace 导航覆盖它，不能再留下同页空槽。
      if (!finishPendingFlowNavigation(true)) {
        restoreFlowOrigin();
        ensureFlowHistorySlot();
      }
    }, 1000);
  }, [ensureFlowHistorySlot, finishPendingFlowNavigation, restoreFlowOrigin]);

  const finishStaleHistoryRecovery = useCallback(() => {
    staleHistoryRecoveryInProgress.current = false;
    if (staleHistoryRecoveryFallbackTimer.current != null) {
      window.clearTimeout(staleHistoryRecoveryFallbackTimer.current);
      staleHistoryRecoveryFallbackTimer.current = null;
    }

    const state = currentHistoryState();
    const next = { ...state };
    delete next[MOBILE_FLOW_HISTORY_KEY];

    const historyUserState = next.usr;
    const restoredState = historyUserState && typeof historyUserState === 'object'
      ? { ...(historyUserState as Record<string, unknown>) }
      : {};
    delete restoredState.mobileMore;
    delete restoredState.showHistoryProgress;
    next.usr = restoredState;
    window.history.replaceState(next, '', window.location.href);

    // popstate 已先通知 React Router；replace 导航让路由上下文同步到清理后的临时状态。
    navigate(`${window.location.pathname}${window.location.search}${window.location.hash}`, {
      replace: true,
      state: restoredState,
    });
    historySlotActive.current = false;
    historyReady.current = true;
    setOutletReady(true);
  }, [navigate]);

  // 硬刷新会生成新会话 marker：退回 marker 前的同页条目，避免首次返回空走一步。
  useLayoutEffect(() => {
    const state = currentHistoryState();
    const marker = flowHistoryMarker.current;
    const staleMarker = (
      Object.prototype.hasOwnProperty.call(state, MOBILE_FLOW_HISTORY_KEY)
      && state[MOBILE_FLOW_HISTORY_KEY] !== marker
    );
    if (staleMarker) {
      historySlotActive.current = false;
      if (!staleHistoryRecoveryInProgress.current) {
        staleHistoryRecoveryInProgress.current = true;
        window.history.back();
        // marker 一定由 pushState 产生并有前项；保留降级仅防浏览器拒绝历史遍历。
        staleHistoryRecoveryFallbackTimer.current = window.setTimeout(() => {
          if (staleHistoryRecoveryInProgress.current) finishStaleHistoryRecovery();
        }, 1000);
      }
    } else {
      historySlotActive.current = state[MOBILE_FLOW_HISTORY_KEY] === marker;
      historyReady.current = true;
      setOutletReady(true);
    }

    return () => {
      historyReady.current = false;
      if (historyReleaseTimer.current != null) window.clearTimeout(historyReleaseTimer.current);
      if (historyReleaseFallbackTimer.current != null) window.clearTimeout(historyReleaseFallbackTimer.current);
      if (historyRecoveryTimer.current != null) window.clearTimeout(historyRecoveryTimer.current);
      if (staleHistoryRecoveryFallbackTimer.current != null) {
        window.clearTimeout(staleHistoryRecoveryFallbackTimer.current);
      }
      if (pendingFlowNavigationGuardTimer.current != null) {
        window.clearTimeout(pendingFlowNavigationGuardTimer.current);
      }
      cancelFlowOriginRestore();
      historyReleaseTimer.current = null;
      historyReleaseFallbackTimer.current = null;
      historyRecoveryTimer.current = null;
      staleHistoryRecoveryFallbackTimer.current = null;
      staleHistoryRecoveryInProgress.current = false;
      pendingFlowNavigationGuardTimer.current = null;
      pendingFlowNavigation.current = null;
      flowReturnOrigin.current = null;
    };
  }, [cancelFlowOriginRestore, finishStaleHistoryRecovery]);

  // 任一真实路由切换都会作废旧页面的滚动恢复，即使随后又很快回到相同 pathname。
  useLayoutEffect(() => {
    const origin = flowReturnOrigin.current;
    if (origin && navigationEpoch.current !== origin.navigationEpoch) {
      cancelFlowOriginRestore();
      flowReturnOrigin.current = null;
    }
    const pending = pendingInteractionOrigin.current;
    if (pending && pending.location !== `${location.pathname}${location.search}`) {
      pendingInteractionOrigin.current = null;
    }
  }, [cancelFlowOriginRestore, location.pathname, location.search, navigationIdentity]);

  // 手机端由 #root 承担滚动；切换顶层路由必须回到页首，才能立即使用下拉刷新。
  useLayoutEffect(() => {
    if (!isMobile) return;
    const scrollRoot = document.getElementById('root');
    if (scrollRoot) scrollRoot.scrollTop = 0;
  }, [isMobile, location.pathname]);

  useEffect(() => {
    const captureInteractionOrigin = (event: PointerEvent | KeyboardEvent) => {
      if (!isMobileRef.current || flowRef.current || flowRegistry.current.size > 0) return;
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      pendingInteractionOrigin.current = {
        location: `${window.location.pathname}${window.location.search}`,
        scrollTop: document.getElementById('root')?.scrollTop ?? 0,
        at: Date.now(),
      };
    };
    document.addEventListener('pointerdown', captureInteractionOrigin, true);
    document.addEventListener('keydown', captureInteractionOrigin, true);
    return () => {
      document.removeEventListener('pointerdown', captureInteractionOrigin, true);
      document.removeEventListener('keydown', captureInteractionOrigin, true);
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      if (staleHistoryRecoveryInProgress.current) {
        finishStaleHistoryRecovery();
        return;
      }
      if (historyReleaseInProgress.current) {
        historyReleaseInProgress.current = false;
        if (historyReleaseFallbackTimer.current != null) {
          window.clearTimeout(historyReleaseFallbackTimer.current);
          historyReleaseFallbackTimer.current = null;
        }
        if (!finishPendingFlowNavigation()) {
          restoreFlowOrigin();
          if (isMobileRef.current && flowRef.current) scheduleHistoryRecovery();
        }
        return;
      }
      if (!historySlotActive.current) return;

      historySlotActive.current = false;
      const activeFlow = isMobileRef.current ? flowRef.current : null;
      if (!activeFlow) return;
      try {
        activeFlow.onBack();
      } finally {
        // onBack 若被脏表单/提交锁拒绝，流程仍在时只恢复同一个槽位。
        scheduleHistoryRecovery();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [finishPendingFlowNavigation, finishStaleHistoryRecovery, restoreFlowOrigin, scheduleHistoryRecovery]);

  useLayoutEffect(() => {
    if (!historyReady.current) return;
    const hasActiveFlow = isMobile && flow != null;
    if (hasActiveFlow) {
      if (historyReleaseTimer.current != null) {
        window.clearTimeout(historyReleaseTimer.current);
        historyReleaseTimer.current = null;
      }
      if (!historyReleaseInProgress.current && historyRecoveryTimer.current == null) {
        ensureFlowHistorySlot();
      }
      return;
    }

    if (historyRecoveryTimer.current != null) {
      window.clearTimeout(historyRecoveryTimer.current);
      historyRecoveryTimer.current = null;
    }
    if (historyReleaseTimer.current != null || historyReleaseInProgress.current) return;
    const state = currentHistoryState();
    if (
      historySlotActive.current
      && state[MOBILE_FLOW_HISTORY_KEY] === flowHistoryMarker.current
    ) {
      // 容纳同一次 React 提交中 A 卸载、B 挂载；只有最终确实无流程才退栈。
      historyReleaseTimer.current = window.setTimeout(() => {
        historyReleaseTimer.current = null;
        if (isMobileRef.current && flowRef.current) {
          ensureFlowHistorySlot();
          return;
        }
        releaseFlowHistorySlot();
      }, 0);
    } else {
      historySlotActive.current = false;
      if (!finishPendingFlowNavigation()) restoreFlowOrigin();
    }
  }, [ensureFlowHistorySlot, finishPendingFlowNavigation, flow, isMobile, releaseFlowHistorySlot, restoreFlowOrigin]);

  const registerFlow = useCallback((next: MobileFlowMeta) => {
    if (flowReturnOrigin.current == null) {
      const pending = pendingInteractionOrigin.current;
      const canUsePending = (
        pending != null
        && pending.location === next.returnLocation
        && Date.now() - pending.at < 1500
      );
      flowReturnOrigin.current = {
        pathname: next.returnPathname,
        location: canUsePending ? pending.location : next.returnLocation,
        scrollTop: canUsePending ? pending.scrollTop : next.returnScrollTop,
        navigationEpoch: navigationEpoch.current,
      };
      pendingInteractionOrigin.current = null;
    }
    flowRegistry.current.set(next.id, next);
    setFlow(next);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (flowRegistry.current.get(next.id) !== next) return;
      flowRegistry.current.delete(next.id);
      setFlow((current) => {
        if (current?.id !== next.id) return current;
        const remaining = Array.from(flowRegistry.current.values());
        return remaining.at(-1) ?? null;
      });
    };
  }, []);

  const navigateFromFlow = useCallback((to: string, options?: MobileFlowNavigationOptions) => {
    const activeFlow = isMobileRef.current ? flowRef.current : null;
    if (!activeFlow) {
      navigate(to, options);
      return;
    }

    const request = { to, options };
    pendingFlowNavigation.current = request;
    activeFlow.onBack();

    if (pendingFlowNavigationGuardTimer.current != null) {
      window.clearTimeout(pendingFlowNavigationGuardTimer.current);
    }
    // onBack 可以因未保存表单被拒绝；流程仍在时撤销待跳转，避免未来关闭时意外离页。
    pendingFlowNavigationGuardTimer.current = window.setTimeout(() => {
      pendingFlowNavigationGuardTimer.current = null;
      if (pendingFlowNavigation.current === request && flowRef.current) {
        pendingFlowNavigation.current = null;
      }
    }, 0);
  }, [navigate]);

  const mobileShellValue = useMemo(
    () => ({ flow, registerFlow, navigateFromFlow }),
    [flow, navigateFromFlow, registerFlow],
  );

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    message.info('已退出登录');
    onLogout();
  };

  const selected = routeKey(location.pathname);
  const locationState = (location.state ?? {}) as { mobileMore?: boolean; showHistoryProgress?: boolean };
  const moreOpen = isMobile && Boolean(locationState.mobileMore);
  const mobileActive = selected === '/transactions'
    ? '/bills'
    : moreOpen || !MOBILE_MAIN_KEYS.has(selected) ? 'more' : selected;

  const openMore = () => {
    navigate(location.pathname, { state: { ...locationState, mobileMore: true } });
  };

  const goTopLevel = (key: string) => {
    if (key === 'more') {
      openMore();
      return;
    }
    navigate(key);
  };

  const openHistoryProgress = () => {
    navigate('/email', { state: { showHistoryProgress: true } });
  };

  return (
    <MobileShellContext.Provider value={mobileShellValue}>
      <UpgradePrompt />
      <div className={`app-shell ${isMobile ? 'app-shell-mobile' : 'app-shell-desktop'}`}>
        {isMobile ? (
          <header className="mobile-app-header">
            {flow || selected === '/transactions' ? (
              <div className="mobile-flow-nav">
                <Button
                  type="text"
                  className="mobile-nav-back-button"
                  icon={<LeftOutlined />}
                  aria-label="返回"
                  onClick={flow?.onBack ?? (() => navigate('/bills'))}
                />
                <div className="mobile-flow-nav-title">{flow?.title ?? '账单明细'}</div>
                <span aria-hidden="true" />
              </div>
            ) : (
              <div
                style={{
                  minHeight: 45,
                  paddingInline: 56,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Typography.Text strong ellipsis>
                  {moreOpen ? '更多' : routeTitle(location.pathname)}
                </Typography.Text>
              </div>
            )}
          </header>
        ) : (
          <header className="desktop-app-header">
            <Typography.Title level={4}>{appName}</Typography.Title>
            <Button icon={<LogoutOutlined />} type="text" onClick={logout}>
              退出登录
            </Button>
          </header>
        )}

        <div className="app-shell-main-row">
          {!isMobile && (
            <aside className="desktop-app-sider">
              <Menu
                mode="inline"
                items={DESKTOP_MENU_ITEMS}
                selectedKeys={[selected]}
                onClick={({ key }) => navigate(key)}
              />
            </aside>
          )}

          <main className="app-shell-content">
            {isMobile && historyGate.blocked && (
              <button type="button" className="mobile-history-task-bar" onClick={openHistoryProgress}>
                <span>
                  <LoadingOutlined spin={historyGate.phase !== 'unknown'} />{' '}
                  {historyGate.phase === 'unknown' ? '正在确认历史拉取状态' : '历史拉取进行中'}
                </span>
                <span>查看进度</span>
              </button>
            )}

            <div className={moreOpen ? 'route-outlet route-outlet-hidden' : 'route-outlet'}>
              {outletReady && <Outlet />}
            </div>

            {moreOpen && (
              <section className="mobile-more-page" aria-label="更多功能">
                <div className="mobile-more-brand">
                  <Typography.Title level={4}>{appName}</Typography.Title>
                  <Tag color="blue">单管理员</Tag>
                </div>
                <List header="管理功能">
                  <List.Item>
                    <Button
                      type="text"
                      block
                      className="mobile-more-action"
                      icon={<MailOutlined />}
                      onClick={() => navigate('/email')}
                    >
                      邮箱绑定
                    </Button>
                  </List.Item>
                  <List.Item>
                    <Button
                      type="text"
                      block
                      className="mobile-more-action"
                      icon={<ExperimentOutlined />}
                      onClick={() => navigate('/parsers')}
                    >
                      解析器中心
                    </Button>
                  </List.Item>
                  <List.Item>
                    <Button
                      type="text"
                      block
                      className="mobile-more-action"
                      icon={<SettingOutlined />}
                      onClick={() => navigate('/settings')}
                    >
                      系统设置
                    </Button>
                  </List.Item>
                </List>
                <List header="账户">
                  <List.Item>
                    <Button
                      type="text"
                      danger
                      block
                      className="mobile-more-action"
                      icon={<LogoutOutlined />}
                      onClick={() => void logout()}
                    >
                      退出登录
                    </Button>
                  </List.Item>
                </List>
              </section>
            )}
          </main>
        </div>

        {isMobile && !flow && (
          <nav className="mobile-bottom-nav" aria-label="主导航">
            <TabBar activeKey={mobileActive} onChange={goTopLevel} safeArea>
              {APP_MENU.filter((item) => MOBILE_MAIN_KEYS.has(item.key)).map((item) => (
                <TabBar.Item
                  key={item.key}
                  icon={item.icon}
                  title={(
                    <button
                      type="button"
                      className="mobile-tab-action"
                      aria-current={mobileActive === item.key ? 'page' : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        goTopLevel(item.key);
                      }}
                    >
                      {item.mobileLabel}
                    </button>
                  )}
                />
              ))}
              <TabBar.Item
                key="more"
                icon={<AppstoreOutlined />}
                title={(
                  <button
                    type="button"
                    className="mobile-tab-action"
                    aria-current={mobileActive === 'more' ? 'page' : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      goTopLevel('more');
                    }}
                  >
                    更多
                  </button>
                )}
              />
            </TabBar>
          </nav>
        )}
      </div>
    </MobileShellContext.Provider>
  );
}

export function Page({
  title,
  extra,
  mobileExtra,
  children,
  className,
}: {
  title: string;
  extra?: ReactNode;
  mobileExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { isMobile } = useResponsive();
  return (
    <div className={`page ${isMobile ? 'page-mobile' : 'page-desktop'} ${className ?? ''}`.trim()}>
      {!isMobile && (
        <div className="page-heading">
          <Typography.Title level={5}>{title}</Typography.Title>
          {extra}
        </div>
      )}
      {isMobile && mobileExtra && <div className="mobile-page-actions">{mobileExtra}</div>}
      {children}
    </div>
  );
}
