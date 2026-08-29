import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Button, Result, Space, Spin } from 'antd';
import { ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { api } from './api/client';
import type { AppInfo, MeInfo, SetupStatus } from './api/types';
import { AppNameContext, DEFAULT_APP_NAME } from './appName';
import Setup from './pages/Setup';
import Login from './pages/Login';
import Layout from './components/Layout';
import { ResponsiveProvider } from './responsive';
import { HistoryGateProvider } from './historyGate';

type LazyPageLoader = () => Promise<{ default: ComponentType }>;

const loadDashboard: LazyPageLoader = () => import('./pages/Dashboard');
const loadCards: LazyPageLoader = () => import('./pages/Cards');
const loadBills: LazyPageLoader = () => import('./pages/Bills');
const loadTransactions: LazyPageLoader = () => import('./pages/Transactions');
const loadReminders: LazyPageLoader = () => import('./pages/Reminders');
const loadEmail: LazyPageLoader = () => import('./pages/Email');
const loadParserCenter: LazyPageLoader = () => import('./pages/ParserCenter');
const loadSettings: LazyPageLoader = () => import('./pages/Settings');

// 路由切换发生在 React transition 内时，新页面可能先挂起再重试。
// lazy 类型必须跨未提交的重试保持同一引用，否则每次重试都会创建新 Promise 并永久停留在旧页面。
const lazyPageCache = new WeakMap<
  LazyPageLoader,
  Map<number, LazyExoticComponent<ComponentType>>
>();

function getLazyPage(loader: LazyPageLoader, retryKey: number) {
  let versions = lazyPageCache.get(loader);
  if (!versions) {
    versions = new Map();
    lazyPageCache.set(loader, versions);
  }
  let PageComponent = versions.get(retryKey);
  if (!PageComponent) {
    PageComponent = lazy(loader);
    versions.set(retryKey, PageComponent);
  }
  return PageComponent;
}

class PageErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error('页面加载失败') };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面渲染失败', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Result
        status="error"
        title="页面暂时无法加载"
        subTitle="网络波动或资源更新可能导致本次加载失败，请重试。"
        extra={(
          <Space wrap>
            <Button
              type="primary"
              icon={<SyncOutlined />}
              style={{ minHeight: 44 }}
              onClick={this.props.onRetry}
            >
              重试
            </Button>
            <Button
              icon={<ReloadOutlined />}
              style={{ minHeight: 44 }}
              onClick={() => window.location.reload()}
            >
              刷新页面
            </Button>
          </Space>
        )}
      />
    );
  }
}

function DeferredPage({ loader }: { loader: LazyPageLoader }) {
  const [retryKey, setRetryKey] = useState(0);
  const PageComponent = useMemo(() => getLazyPage(loader, retryKey), [loader, retryKey]);
  return (
    <PageErrorBoundary key={retryKey} onRetry={() => setRetryKey((key) => key + 1)}>
      <Suspense
        fallback={(
          <div style={{ display: 'grid', minHeight: 180, placeItems: 'center' }}>
            <Spin size="large" />
          </div>
        )}
      >
        <PageComponent />
      </Suspense>
    </PageErrorBoundary>
  );
}

/**
 * 启动状态机：
 * loading → GET /api/setup/status
 *   ├─ installed: true  → 走登录态判断（GET /api/auth/me）
 *   └─ installed: false → 渲染安装向导（全屏，不进 Layout）
 * 应用名从 GET /api/app 加载（APP_NAME 环境变量可自定义）
 */
type Phase = 'loading' | 'setup' | 'ready';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [authed, setAuthed] = useState(false);
  const [appName, setAppName] = useState(DEFAULT_APP_NAME);

  useEffect(() => {
    api
      .get<AppInfo>('/api/app')
      .then((info) => {
        // 接口返回空名/异常数据时回退默认名
        const name = typeof info?.name === 'string' && info.name.trim() ? info.name : DEFAULT_APP_NAME;
        setAppName(name);
        document.title = name;
      })
      .catch(() => {/* 网络错误等：保持默认名 */});

    api
      .get<SetupStatus>('/api/setup/status')
      .then(async (s) => {
        if (!s.installed) {
          setPhase('setup');
          return;
        }
        try {
          await api.get<MeInfo>('/api/auth/me');
          setAuthed(true);
        } catch {
          setAuthed(false);
        }
        setPhase('ready');
      })
      .catch(() => setPhase('setup')); // 状态接口异常也进向导，由向导页展示错误并支持重试
  }, []);

  const content = (() => {
    if (phase === 'loading') {
      return (
        <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
          <Spin size="large" description="加载中…">
            <div style={{ width: 120 }} />
          </Spin>
        </div>
      );
    }

    if (phase === 'setup') {
      // 安装完成后进入正常流程（未登录 → 登录页）
      return <Setup onDone={() => { setAuthed(false); setPhase('ready'); }} />;
    }

    return (
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={authed ? <Navigate to="/" replace /> : <Login onSuccess={() => setAuthed(true)} />}
          />
          <Route
            path="/"
            element={
              authed ? (
                <HistoryGateProvider>
                  <Layout onLogout={() => setAuthed(false)} />
                </HistoryGateProvider>
              ) : (
                <Navigate to="/login" replace />
              )
            }
          >
            <Route index element={<DeferredPage loader={loadDashboard} />} />
            <Route path="cards" element={<DeferredPage loader={loadCards} />} />
            <Route path="bills" element={<DeferredPage loader={loadBills} />} />
            <Route path="transactions" element={<DeferredPage loader={loadTransactions} />} />
            <Route path="reminders" element={<DeferredPage loader={loadReminders} />} />
            <Route path="email" element={<DeferredPage loader={loadEmail} />} />
            <Route path="parsers" element={<DeferredPage loader={loadParserCenter} />} />
            <Route path="settings" element={<DeferredPage loader={loadSettings} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    );
  })();

  return (
    <AppNameContext.Provider value={appName}>
      <ResponsiveProvider>{content}</ResponsiveProvider>
    </AppNameContext.Provider>
  );
}
