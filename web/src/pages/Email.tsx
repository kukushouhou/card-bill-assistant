import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { CloudDownloadOutlined, DownloadOutlined, HistoryOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Virtuoso } from 'react-virtuoso';
import { api, ApiError } from '../api/client';
import type { EmailAccount, HistorySyncState, MailLogRow, PagedMailLogs, SyncSummary } from '../api/types';
import { Page } from '../components/Layout';
import { useResponsive, useResetOnModeChange } from '../responsive';
import { useHistoryGate } from '../historyGate';
import {
  InlineConfirm,
  MobileFlow,
  MobilePullToRefresh,
  useCoalescedRefresh,
} from '../components/MobilePrimitives';
import './email.css';

interface AccountFormValues {
  email: string;
  imapHost: string;
  imapPort: number;
  tls: boolean;
  authUser: string;
  authPassword?: string;
}

interface AccountFormDraft {
  values: Partial<AccountFormValues>;
  dirty: boolean;
}

function accountFormInitialValues(initial?: EmailAccount | null): Partial<AccountFormValues> {
  if (!initial) return { imapPort: 993, tls: true };
  return {
    email: initial.email,
    imapHost: initial.imapHost,
    imapPort: initial.imapPort,
    tls: initial.tls,
    authUser: initial.authUser,
  };
}

function definedAccountDraft(values?: Partial<AccountFormValues>): Partial<AccountFormValues> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<AccountFormValues>;
}

function normalizedAccountFormValues(values: Partial<AccountFormValues>) {
  return {
    email: values.email ?? '',
    imapHost: values.imapHost ?? '',
    imapPort: values.imapPort ?? null,
    tls: values.tls ?? false,
    authUser: values.authUser ?? '',
    authPassword: values.authPassword ?? '',
  };
}

function accountFormChanged(values: Partial<AccountFormValues>, baseline: Partial<AccountFormValues>): boolean {
  return JSON.stringify(normalizedAccountFormValues(values)) !== JSON.stringify(normalizedAccountFormValues(baseline));
}

const PRESETS: Array<{ host: string; label: string }> = [
  { host: 'imap.qq.com', label: 'QQ 邮箱（imap.qq.com）' },
  { host: 'imap.163.com', label: '网易 163（imap.163.com）' },
  { host: 'imap.gmail.com', label: 'Gmail（imap.gmail.com）' },
  { host: 'imap.aliyun.com', label: '阿里云邮箱（imap.aliyun.com）' },
  { host: 'imap.126.com', label: '网易 126（imap.126.com）' },
];

/** 同步结果分段文案：图片/错误为零时不显示，出现后才展示；未匹配保持常显 */
function syncSummaryText(s: { matched: number; unmatched: number; image: number; errors: number }): string {
  const parts = [`匹配 ${s.matched}`, `未匹配 ${s.unmatched}`];
  if (s.image > 0) parts.push(`图片 ${s.image}`);
  if (s.errors > 0) parts.push(`错误 ${s.errors}`);
  return parts.join('，');
}

function AccountForm({
  initial,
  onOk,
  onCancel,
  confirmLoading,
  disabled,
  draft,
  onDraftChange,
}: {
  initial?: EmailAccount | null;
  onOk: (values: AccountFormValues, test: boolean) => Promise<void>;
  onCancel: () => void;
  confirmLoading: boolean;
  disabled: boolean;
  draft: AccountFormDraft | null;
  onDraftChange: (draft: AccountFormDraft) => void;
}) {
  const [form] = Form.useForm<AccountFormValues>();
  const [testing, setTesting] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const { isMobile } = useResponsive();
  const baseline = useRef(accountFormInitialValues(initial)).current;
  const formInitialValues = useRef({
    ...baseline,
    ...definedAccountDraft(draft?.values),
  }).current;
  const busyRef = useRef(false);

  useResetOnModeChange(() => setLeaveConfirm(false));

  // 使用唯一表单名隔离浏览器表单恢复，再显式写入一次，避免新建页的空值覆盖编辑页预填。
  useEffect(() => {
    form.setFieldsValue(formInitialValues);
  }, [form, formInitialValues]);

  const submit = async (test: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const values = await form.validateFields();
      if (test) {
        setTesting(true);
        await onOk(values, true);
      } else {
        await onOk(values, false);
      }
    } catch (error) {
      // AntD 字段校验失败已经在字段旁展示，不制造未处理 Promise。
      if (!(error && typeof error === 'object' && 'errorFields' in error)) throw error;
    } finally {
      busyRef.current = false;
      setTesting(false);
    }
  };

  const requestCancel = () => {
    if (confirmLoading || testing || busyRef.current) return;
    if (isMobile && draft?.dirty) {
      setLeaveConfirm(true);
      return;
    }
    onCancel();
  };

  const content = (
    <>
      {disabled && <Alert type="warning" showIcon title="历史拉取进行中，暂时不能变更邮箱账户" />}
      <Typography.Paragraph type="secondary">
        使用 IMAP 只读方式拉取账单邮件（不标记已读、不删信）。QQ/163 等需先在邮箱设置中开启 IMAP 并使用授权码。
      </Typography.Paragraph>
      <Form
        form={form}
        name={initial ? `email-account-${initial.id}` : 'email-account-new'}
        layout="vertical"
        autoComplete="off"
        initialValues={formInitialValues}
        onValuesChange={(_, values) =>
          onDraftChange({ values, dirty: accountFormChanged(values, baseline) })
        }
      >
        <Form.Item
          name="email"
          label="邮箱地址"
          rules={[{ required: true, type: 'email', message: '邮箱格式错误' }]}
        >
          <Input placeholder="you@example.com" autoComplete="off" />
        </Form.Item>
        <Form.Item name="imapHost" label="IMAP 服务器" rules={[{ required: true, message: '必填' }]}>
          <Select
            showSearch
            options={PRESETS.map((p) => ({ value: p.host, label: p.label }))}
            placeholder="选择或输入服务器地址"
          />
        </Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="imapPort" label="端口" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="tls" label="SSL/TLS" valuePropName="checked" style={{ paddingTop: 30 }}>
            <Switch />
          </Form.Item>
        </Space>
        <Form.Item name="authUser" label="登录账号" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="通常为邮箱地址" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="authPassword"
          label={initial ? '授权码（留空则不修改）' : '授权码 / 密码'}
          rules={initial ? [] : [{ required: true, message: '必填' }]}
        >
          <Input.Password placeholder="IMAP 授权码" autoComplete="new-password" />
        </Form.Item>
      </Form>
    </>
  );

  const footer = leaveConfirm ? undefined : isMobile ? (
    <div className="mobile-email-editor-actions">
      <div className="mobile-email-editor-aux-row">
        <Button
          type="text"
          onClick={() => void submit(true)}
          loading={testing}
          disabled={disabled || confirmLoading}
        >
          测试连接并保存
        </Button>
      </div>
      <div className="mobile-email-editor-main-row">
        <Button onClick={requestCancel} disabled={confirmLoading || testing}>
          取消
        </Button>
        <Button
          type="primary"
          onClick={() => void submit(false)}
          loading={confirmLoading}
          disabled={disabled || testing}
        >
          保存
        </Button>
      </div>
    </div>
  ) : (
    <Space direction="horizontal">
      <Button
        onClick={() => void submit(true)}
        loading={testing}
        disabled={disabled || confirmLoading}
      >
        测试连接并保存
      </Button>
      <Button
        type="primary"
        onClick={() => void submit(false)}
        loading={confirmLoading}
        disabled={disabled || testing}
      >
        保存
      </Button>
      <Button onClick={requestCancel} disabled={confirmLoading || testing}>
        取消
      </Button>
    </Space>
  );

  const title = initial ? `编辑邮箱 - ${initial.email}` : '绑定邮箱账户';
  if (isMobile) {
    return (
      <MobileFlow title={initial ? '编辑邮箱' : '绑定邮箱'} onBack={requestCancel} footer={footer}>
        <Typography.Title level={5}>{title}</Typography.Title>
        {content}
        {leaveConfirm && (
          <InlineConfirm
            title="放弃未保存的更改？"
            description="返回后，本次填写的邮箱账户信息不会保存。"
            confirmText="放弃更改"
            danger={false}
            onConfirm={onCancel}
            onCancel={() => setLeaveConfirm(false)}
          />
        )}
      </MobileFlow>
    );
  }

  return (
    <Modal title={title} open onCancel={requestCancel} destroyOnHidden footer={footer}>
      {content}
    </Modal>
  );
}

export default function Email() {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const location = useLocation();
  const navigate = useNavigate();
  const historyGate = useHistoryGate();
  const accounts = historyGate.accounts;
  const [activeTab, setActiveTab] = useState('accounts');
  const [editing, setEditing] = useState<EmailAccount | null | undefined>(undefined);
  const [accountDraft, setAccountDraft] = useState<AccountFormDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [resyncing, setResyncing] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [logs, setLogs] = useState<PagedMailLogs>({ total: 0, page: 1, pageSize: 20, items: [] });
  const [logFilter, setLogFilter] = useState<{ accountId?: number; status?: string }>({});
  // 默认隐藏未匹配（营销/通知类邮件），勾选后才显示
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [logLoading, setLogLoading] = useState(false);
  const [logLoadingMore, setLogLoadingMore] = useState(false);
  const [logLoadFailure, setLogLoadFailure] = useState<{ page: number; message: string } | null>(null);
  const [mobileScrollParent, setMobileScrollParent] = useState<HTMLElement | null>(null);
  const [historyView, setHistoryView] = useState(false);
  const [pendingHistoryAccount, setPendingHistoryAccount] = useState<EmailAccount | null>(null);
  const [mobileConfirm, setMobileConfirm] = useState<{
    kind: 'history' | 'resync' | 'remove';
    account: EmailAccount;
  } | null>(null);
  const accountBusyRef = useRef(false);
  const syncBusyRef = useRef(new Set<number>());
  const resyncBusyRef = useRef(new Set<number>());
  const removeBusyRef = useRef(new Set<number>());
  const toggleBusyRef = useRef(new Set<number>());
  const logRequestsRef = useRef(new Map<string, Promise<void>>());
  const logReplaceRequestRef = useRef<string | null>(null);
  const logAppendRequestRef = useRef<string | null>(null);
  const logScopeVersionRef = useRef(0);
  const logGenerationRef = useRef(0);
  const mobileLoadMoreRequestedRef = useRef(false);
  const completedHistoryRef = useRef<string | null>(null);

  useResetOnModeChange(() => {
    setMobileConfirm(null);
    setLogPage(1);
    setLogs({ total: 0, page: 1, pageSize: 20, items: [] });
    setLogLoadFailure(null);
    mobileLoadMoreRequestedRef.current = false;
    logScopeVersionRef.current += 1;
    logGenerationRef.current += 1;
  });

  useEffect(() => {
    setMobileScrollParent(isMobile ? document.getElementById('root') : null);
  }, [isMobile]);

  const loadAccounts = useCallback(async () => {
    await historyGate.scan();
  }, [historyGate.scan]);

  const logQueryKey = `${logFilter.accountId ?? ''}:${logFilter.status ?? ''}:${showUnmatched ? 1 : 0}`;
  const latestLogQueryRef = useRef(logQueryKey);
  const previousLogQueryRef = useRef(logQueryKey);
  useLayoutEffect(() => {
    latestLogQueryRef.current = logQueryKey;
    if (previousLogQueryRef.current === logQueryKey) return;
    previousLogQueryRef.current = logQueryKey;
    logScopeVersionRef.current += 1;
    logGenerationRef.current += 1;
    mobileLoadMoreRequestedRef.current = false;
    setLogLoadFailure(null);
    setLogs({ total: 0, page: 1, pageSize: 20, items: [] });
  }, [logQueryKey]);

  const loadLogsPage = useCallback((requestedPage: number, append: boolean) => {
    const requestedQuery = logQueryKey;
    const requestedScopeVersion = logScopeVersionRef.current;
    const requestKey = `${requestedQuery}:${requestedScopeVersion}:${requestedPage}:${append ? 'append' : 'replace'}`;
    const existing = logRequestsRef.current.get(requestKey);
    if (existing) return existing;

    const generation = append ? logGenerationRef.current : ++logGenerationRef.current;
    if (append) {
      logAppendRequestRef.current = requestKey;
      setLogLoadingMore(true);
    } else {
      logReplaceRequestRef.current = requestKey;
      setLogLoading(true);
    }
    setLogLoadFailure((current) => (current?.page === requestedPage ? null : current));

    const pending = (async () => {
      try {
        const q = new URLSearchParams({ page: String(requestedPage), pageSize: '20' });
        if (logFilter.accountId) q.set('accountId', String(logFilter.accountId));
        if (logFilter.status) q.set('status', logFilter.status);
        else if (showUnmatched) q.set('includeUnmatched', '1');
        const nextLogs = await api.get<PagedMailLogs>(`/api/email/logs?${q}`);
        // 筛选、刷新或显示模式变化后，旧范围的迟到响应不得污染新列表。
        if (
          latestLogQueryRef.current !== requestedQuery
          || logScopeVersionRef.current !== requestedScopeVersion
          || logGenerationRef.current !== generation
        ) return;
        setLogs((current) => {
          if (!append) return nextLogs;
          const seen = new Set(current.items.map((item) => item.id));
          const appendedItems = nextLogs.items.filter((item) => !seen.has(item.id));
          return {
            ...nextLogs,
            items: [...current.items, ...appendedItems],
          };
        });
      } catch (error) {
        if (
          latestLogQueryRef.current === requestedQuery
          && logScopeVersionRef.current === requestedScopeVersion
          && logGenerationRef.current === generation
        ) {
          setLogLoadFailure({
            page: requestedPage,
            message: error instanceof ApiError ? error.message : '同步日志加载失败',
          });
        }
        throw error;
      } finally {
        logRequestsRef.current.delete(requestKey);
        if (append && logAppendRequestRef.current === requestKey) {
          logAppendRequestRef.current = null;
          mobileLoadMoreRequestedRef.current = false;
          setLogLoadingMore(false);
        }
        if (!append && logReplaceRequestRef.current === requestKey) {
          logReplaceRequestRef.current = null;
          setLogLoading(false);
        }
      }
    })();
    logRequestsRef.current.set(requestKey, pending);
    return pending;
  }, [logFilter.accountId, logFilter.status, logQueryKey, showUnmatched]);

  const refreshAccounts = useCoalescedRefresh(loadAccounts);
  const refreshLogs = useCallback(async (options?: { freshAfterInFlight?: boolean }) => {
    const requestedPage = isMobile ? 1 : logPage;
    if (isMobile) {
      setLogPage(1);
      mobileLoadMoreRequestedRef.current = false;
    }
    const requestKey = `${logQueryKey}:${logScopeVersionRef.current}:${requestedPage}:replace`;
    const current = logRequestsRef.current.get(requestKey);
    if (current && options?.freshAfterInFlight) {
      await current.catch(() => undefined);
    }
    return loadLogsPage(requestedPage, false);
  }, [isMobile, loadLogsPage, logPage, logQueryKey]);

  useEffect(() => {
    void refreshAccounts().catch(() => undefined);
  }, [refreshAccounts]);
  useEffect(() => {
    void loadLogsPage(logPage, isMobile && logPage > 1).catch(() => undefined);
  }, [isMobile, loadLogsPage, logPage]);

  useEffect(() => {
    const state = (location.state ?? {}) as { showHistoryProgress?: boolean };
    if (!state.showHistoryProgress) return;
    setHistoryView(true);
    const nextState = { ...state };
    delete nextState.showHistoryProgress;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: nextState,
    });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (historyGate.focusedTask && !historyGate.focusedTask.state.running) {
      const completionKey = [
        historyGate.focusedTask.account.id,
        historyGate.focusedTask.state.finishedAt ?? '',
        historyGate.focusedTask.state.processed,
      ].join(':');
      if (completedHistoryRef.current === completionKey) return;
      completedHistoryRef.current = completionKey;
      void refreshLogs({ freshAfterInFlight: true }).catch(() => undefined);
    }
  }, [historyGate.focusedTask, refreshLogs]);

  const guardRestricted = () => {
    if (historyGate.mayRunRestrictedAction()) return true;
    message.warning(historyGate.blockedReason);
    return false;
  };

  const submitAccount = async (values: AccountFormValues, test: boolean) => {
    if (accountBusyRef.current || !guardRestricted()) return;
    accountBusyRef.current = true;
    setSaving(true);
    let stage: 'testing' | 'saving' = test ? 'testing' : 'saving';
    try {
      if (test) {
        const r = await api.post<{ mailboxCount: number }>('/api/email/accounts/test', values);
        message.success(`连接成功，收件箱共 ${r.mailboxCount} 封邮件`);
        stage = 'saving';
      }
      if (editing) {
        const { authPassword, ...rest } = values;
        await api.put(`/api/email/accounts/${editing.id}`, authPassword ? values : rest);
        message.success('已保存');
      } else {
        await api.post('/api/email/accounts', values);
        message.success('已绑定，可点击「同步」拉取账单');
      }
      setEditing(undefined);
      setAccountDraft(null);
      await refreshAccounts({ freshAfterInFlight: true }).catch(() => undefined);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : stage === 'testing' ? '连接失败' : '保存失败');
    } finally {
      accountBusyRef.current = false;
      setSaving(false);
    }
  };

  const sync = async (id: number) => {
    if (syncBusyRef.current.has(id) || !guardRestricted()) return;
    syncBusyRef.current.add(id);
    setSyncing(id);
    try {
      const s = await api.post<SyncSummary>(`/api/email/accounts/${id}/sync`);
      message.success(`同步完成：新增 ${s.synced}，${syncSummaryText(s)}`);
      await Promise.allSettled([
        refreshAccounts({ freshAfterInFlight: true }),
        refreshLogs({ freshAfterInFlight: true }),
      ]);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '同步失败');
    } finally {
      syncBusyRef.current.delete(id);
      setSyncing((current) => (current === id ? null : current));
    }
  };

  const resync = async (id: number) => {
    if (resyncBusyRef.current.has(id) || !guardRestricted()) return;
    resyncBusyRef.current.add(id);
    setResyncing(id);
    try {
      const s = await api.post<SyncSummary>(`/api/email/accounts/${id}/resync`);
      message.success(`重新同步完成：新增 ${s.synced}，${syncSummaryText(s)}`);
      await Promise.allSettled([
        refreshAccounts({ freshAfterInFlight: true }),
        refreshLogs({ freshAfterInFlight: true }),
      ]);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '重新同步失败');
    } finally {
      resyncBusyRef.current.delete(id);
      setResyncing((current) => (current === id ? null : current));
    }
  };

  const startHistory = async (account: EmailAccount) => {
    if (!guardRestricted()) return;
    setPendingHistoryAccount(account);
    if (isMobile) setHistoryView(true);
    try {
      await historyGate.startHistory(account);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '启动历史拉取失败');
    } finally {
      setPendingHistoryAccount(null);
    }
  };

  const toggleEnabled = async (account: EmailAccount, enabled: boolean) => {
    if (toggleBusyRef.current.has(account.id) || !guardRestricted()) return;
    toggleBusyRef.current.add(account.id);
    setToggling(account.id);
    try {
      await api.put(`/api/email/accounts/${account.id}/enabled`, { enabled });
      await refreshAccounts({ freshAfterInFlight: true }).catch(() => undefined);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      toggleBusyRef.current.delete(account.id);
      setToggling((current) => (current === account.id ? null : current));
    }
  };

  const remove = async (id: number) => {
    if (removeBusyRef.current.has(id) || !guardRestricted()) return;
    removeBusyRef.current.add(id);
    setRemoving(id);
    try {
      await api.delete(`/api/email/accounts/${id}`);
      message.success('已解绑');
      await Promise.allSettled([
        refreshAccounts({ freshAfterInFlight: true }),
        refreshLogs({ freshAfterInFlight: true }),
      ]);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    } finally {
      removeBusyRef.current.delete(id);
      setRemoving((current) => (current === id ? null : current));
    }
  };

  const refreshPage = async () => {
    const results = await Promise.allSettled([refreshAccounts(), refreshLogs()]);
    if (results.some((result) => result.status === 'rejected')) {
      message.warning('部分数据刷新失败');
      throw new Error('部分数据刷新失败');
    }
  };

  const progressTask = historyGate.focusedTask?.state.running
    ? historyGate.focusedTask
    : historyGate.runningTasks[0] ?? historyGate.focusedTask ?? null;
  const historyState: HistorySyncState | null = progressTask?.state ?? null;
  const historyAccount = progressTask?.account ?? pendingHistoryAccount;

  const closeHistoryProgress = () => {
    setHistoryView(false);
    if (!historyState?.running) historyGate.dismissFocusedTask();
  };

  const openEditor = (account: EmailAccount | null) => {
    if (!guardRestricted()) return;
    setAccountDraft(null);
    setEditing(account);
  };

  const closeEditor = () => {
    setAccountDraft(null);
    setEditing(undefined);
  };

  const STATUS_TAG: Record<string, { color: string; text: string }> = {
    matched: { color: 'green', text: '已入账' },
    unmatched: { color: 'default', text: '未匹配' },
    image: { color: 'purple', text: '图片账单' },
    error: { color: 'red', text: '解析失败' },
  };

  const historyProgressContent = historyGate.phase === 'unknown' ? (
    <Alert
      type="warning"
      showIcon
      title="正在确认历史拉取状态"
      description="状态确认完成前，邮箱变更和 IMAP 操作保持禁用。"
      action={<Button onClick={() => void historyGate.scan().catch(() => undefined)}>重试查询</Button>}
    />
  ) : historyGate.progressUnavailable ? (
    <Alert
      type="warning"
      showIcon
      title="先前的任务进度当前不可用"
      description="可查看邮箱账户和同步日志确认已有结果。"
    />
  ) : historyGate.phase === 'starting' ? (
    <div className="mobile-section-loading">
      <Spin description="正在启动历史拉取…"><div style={{ width: 180, height: 60 }} /></Spin>
    </div>
  ) : historyState ? (
    <div>
      <Progress
        percent={historyState.total > 0 ? (historyState.processed / historyState.total) * 100 : 0}
        status={historyState.running ? 'active' : historyState.error ? 'exception' : 'success'}
        format={(percent) => `${(percent ?? 0).toFixed(1)}%（${historyState.processed}/${historyState.total}）`}
      />
      <Typography.Paragraph style={{ marginTop: 12 }}>
        {[
          `匹配账单：${historyState.matched}`,
          `未匹配：${historyState.unmatched}`,
          ...(historyState.image > 0 ? [`图片账单：${historyState.image}`] : []),
          ...(historyState.errors > 0 ? [`错误：${historyState.errors}`] : []),
        ].join(' ｜ ')}
      </Typography.Paragraph>
      {historyGate.runningTasks.length > 1 && (
        <Alert
          type="info"
          showIcon
          title={`当前共有 ${historyGate.runningTasks.length} 个历史任务`}
          description={historyGate.runningTasks
            .map((item) => `${item.account.email}：${item.state.processed}/${item.state.total}`)
            .join('；')}
          style={{ marginBottom: 12 }}
        />
      )}
      {historyState.running && (
        <Alert type="info" showIcon title="任务将在后台继续，可离开此页面后从任务条返回查看。" />
      )}
      {historyState.error && (
        <Alert title="历史拉取中断" description={historyState.error} type="error" showIcon />
      )}
    </div>
  ) : (
    <Empty description="当前没有活动的历史拉取任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
  );

  if (isMobile && editing !== undefined) {
    return (
      <AccountForm
        initial={editing}
        onOk={submitAccount}
        onCancel={closeEditor}
        confirmLoading={saving}
        disabled={historyGate.blocked}
        draft={accountDraft}
        onDraftChange={setAccountDraft}
      />
    );
  }

  if (isMobile && mobileConfirm) {
    const { account, kind } = mobileConfirm;
    const config =
      kind === 'history'
        ? {
            title: `拉取 ${account.email} 的全部历史邮件？`,
            description: '任务可能耗时较长，启动后会持续显示进度，已处理邮件会自动跳过。',
            confirmText: '开始历史拉取',
            action: () => startHistory(account),
            danger: false,
          }
        : kind === 'resync'
          ? {
              title: `重新同步 ${account.email}？`,
              description: '将清除该账户已有同步日志、重置同步游标，并按同步天数范围重新拉取邮件。',
              confirmText: '重新同步',
              action: () => resync(account.id),
              danger: true,
            }
          : {
              title: `解绑 ${account.email}？`,
              description:
                '解绑会删除该邮箱账户与全部同步日志，不会删除卡片和账单；依赖该账户或日志的历史交易明细将无法再实时读取。此操作不可恢复。',
              confirmText: '解绑邮箱',
              action: () => remove(account.id),
              danger: true,
            };
    return (
      <MobileFlow title="确认操作" onBack={() => setMobileConfirm(null)}>
        <InlineConfirm
          title={config.title}
          description={config.description}
          confirmText={config.confirmText}
          danger={config.danger}
          loading={kind === 'resync' ? resyncing === account.id : kind === 'remove' ? removing === account.id : false}
          onCancel={() => setMobileConfirm(null)}
          onConfirm={() => {
            setMobileConfirm(null);
            void config.action();
          }}
        />
      </MobileFlow>
    );
  }

  if (isMobile && historyView) {
    return (
      <MobileFlow
        title="历史拉取进度"
        onBack={closeHistoryProgress}
        footer={<Button block onClick={closeHistoryProgress}>返回邮箱绑定</Button>}
      >
        <MobilePullToRefresh onRefresh={refreshPage}>
          {historyAccount && <Typography.Title level={5}>{historyAccount.email}</Typography.Title>}
          {historyProgressContent}
        </MobilePullToRefresh>
      </MobileFlow>
    );
  }

  if (isMobile) {
    const accountList = (
      <div className="mobile-email-list">
        {historyGate.blocked && (
          <Alert
            type="warning"
            showIcon
            title={historyGate.blockedReason}
            description="账户与日志仍可查看，邮箱变更、同步和其他 IMAP 操作暂不可用。"
            action={<Button onClick={() => setHistoryView(true)}>查看进度</Button>}
          />
        )}
        {accounts.length === 0 ? (
          <Empty description="尚未绑定邮箱，绑定后可自动同步信用卡账单" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          accounts.map((account) => (
            <Card key={account.id} className="mobile-entity-card" size="small">
              <div className="mobile-entity-heading">
                <div>
                  <Typography.Text strong>{account.email}</Typography.Text>
                  <Typography.Text type="secondary">
                    {account.imapHost}:{account.imapPort}{account.tls ? ' · SSL' : ''}
                  </Typography.Text>
                </div>
                <Switch
                  className="mobile-email-switch"
                  checked={account.enabled}
                  aria-label={`${account.email} 邮箱同步${account.enabled ? '已启用' : '已停用'}`}
                  loading={toggling === account.id}
                  disabled={historyGate.blocked || toggling === account.id}
                  onChange={(enabled) => void toggleEnabled(account, enabled)}
                />
              </div>
              <Typography.Text type="secondary">
                上次同步：{account.lastSyncAt ? dayjs(account.lastSyncAt).format('YYYY-MM-DD HH:mm') : '从未'}
              </Typography.Text>
              <div className="mobile-action-grid">
                <Button
                  disabled={historyGate.blocked || syncing === account.id || resyncing === account.id}
                  onClick={() => setMobileConfirm({ kind: 'history', account })}
                >
                  拉取历史
                </Button>
                <Button
                  type="primary"
                  ghost
                  loading={syncing === account.id}
                  disabled={historyGate.blocked || resyncing === account.id}
                  onClick={() => void sync(account.id)}
                >
                  同步
                </Button>
                <Button
                  disabled={historyGate.blocked || syncing === account.id}
                  loading={resyncing === account.id}
                  onClick={() => setMobileConfirm({ kind: 'resync', account })}
                >
                  重新同步
                </Button>
                <Button
                  disabled={historyGate.blocked}
                  onClick={() => {
                    openEditor(account);
                  }}
                >
                  编辑
                </Button>
                <Button
                  className="mobile-email-account-unbind"
                  danger
                  loading={removing === account.id}
                  disabled={historyGate.blocked || removing === account.id}
                  onClick={() => setMobileConfirm({ kind: 'remove', account })}
                >
                  解绑
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>
    );

    const logList = (
      <div className="mobile-email-logs">
        <div className="mobile-filter-stack">
          <Select
            allowClear
            placeholder="全部账户"
            value={logFilter.accountId}
            onChange={(value) => {
              setLogPage(1);
              mobileLoadMoreRequestedRef.current = false;
              setLogFilter((filter) => ({ ...filter, accountId: value }));
            }}
            options={accounts.map((account) => ({ value: account.id, label: account.email }))}
          />
          <Select
            allowClear
            placeholder="全部状态"
            value={logFilter.status}
            onChange={(value) => {
              setLogPage(1);
              mobileLoadMoreRequestedRef.current = false;
              setLogFilter((filter) => ({ ...filter, status: value }));
            }}
            options={Object.entries(STATUS_TAG).map(([value, item]) => ({ value, label: item.text }))}
          />
          <Checkbox
            checked={showUnmatched}
            onChange={(event) => {
              setLogPage(1);
              mobileLoadMoreRequestedRef.current = false;
              setShowUnmatched(event.target.checked);
            }}
          >
            显示未匹配
          </Checkbox>
        </div>
        {logLoadFailure?.page === 1 && (
          <Alert
            type="error"
            showIcon
            title="同步日志加载失败"
            description={logLoadFailure.message}
            action={(
              <Button
                size="small"
                onClick={() => void loadLogsPage(1, false).catch(() => undefined)}
              >
                重试
              </Button>
            )}
          />
        )}
        {logLoading && logs.items.length === 0 ? (
          <div className="mobile-section-loading"><Spin /></div>
        ) : logs.items.length === 0 ? (
          logLoadFailure?.page === 1
            ? null
            : <Empty description="暂无同步日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : !mobileScrollParent ? (
          <div className="mobile-section-loading" aria-label="正在准备同步日志列表"><Spin size="small" /></div>
        ) : (
          <Virtuoso
            aria-label="同步日志列表"
            customScrollParent={mobileScrollParent}
            data={logs.items}
            increaseViewportBy={{ top: 320, bottom: 640 }}
            computeItemKey={(_, log) => log.id}
            endReached={() => {
              if (
                mobileLoadMoreRequestedRef.current
                || logLoadingMore
                || logLoadFailure
                || logs.items.length >= logs.total
              ) return;
              mobileLoadMoreRequestedRef.current = true;
              setLogPage(logs.page + 1);
            }}
            itemContent={(_, log) => (
              <div style={{ paddingBottom: 12 }}>
                <Card className="mobile-entity-card" size="small">
                  <div className="mobile-entity-heading">
                    <Typography.Text strong>{log.subject || '（无主题）'}</Typography.Text>
                    <Tag color={STATUS_TAG[log.status]?.color}>{STATUS_TAG[log.status]?.text ?? log.status}</Tag>
                  </div>
                  <Typography.Text type="secondary">{log.fromAddress}</Typography.Text>
                  <Typography.Text type="secondary">{dayjs(log.mailDate).format('YYYY-MM-DD HH:mm')}</Typography.Text>
                  <Typography.Text>解析器：{log.parserId || '-'}</Typography.Text>
                  {log.error && <Typography.Text type="danger">{log.error}</Typography.Text>}
                </Card>
              </div>
            )}
            components={{
              Footer: () => (
                <div style={{ padding: '2px 0 14px', textAlign: 'center' }}>
                  {logLoadFailure && logLoadFailure.page > 1 ? (
                    <Button
                      onClick={() => {
                        mobileLoadMoreRequestedRef.current = true;
                        void loadLogsPage(logLoadFailure.page, true).catch(() => undefined);
                      }}
                    >
                      加载失败，点击重试
                    </Button>
                  ) : logLoadingMore ? (
                    <Space size={8}><Spin size="small" /><Typography.Text type="secondary">正在加载更多</Typography.Text></Space>
                  ) : logs.items.length < logs.total ? (
                    <Typography.Text type="secondary">继续上滑自动加载</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">共 {logs.total} 条 · 已全部加载</Typography.Text>
                  )}
                </div>
              ),
            }}
          />
        )}
      </div>
    );

    return (
      <Page title="邮箱绑定">
        <MobilePullToRefresh onRefresh={refreshPage}>
          <div className="mobile-page-actions">
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={historyGate.blocked}
            onClick={() => {
              openEditor(null);
            }}
          >
            绑定邮箱
          </Button>
          </div>
          <Tabs
            activeKey={activeTab}
            onChange={(key) => {
              if (key === 'logs' && activeTab !== 'logs' && logPage > 1) {
                logScopeVersionRef.current += 1;
                logGenerationRef.current += 1;
                mobileLoadMoreRequestedRef.current = false;
                setLogLoadFailure(null);
                setLogs({ total: 0, page: 1, pageSize: 20, items: [] });
                setLogPage(1);
              }
              setActiveTab(key);
            }}
            items={[
              { key: 'accounts', label: '邮箱账户', children: accountList },
              { key: 'logs', label: '同步日志', children: logList },
            ]}
          />
        </MobilePullToRefresh>
      </Page>
    );
  }

  return (
    <Page
      title="邮箱绑定"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void refreshPage()}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={historyGate.blocked}
            onClick={() => {
              openEditor(null);
            }}
          >
            绑定邮箱
          </Button>
        </Space>
      }
    >
      {historyGate.blocked && (
        <Alert
          type="warning"
          showIcon
          title={historyGate.blockedReason}
          description="邮箱变更、同步和其他用户触发的 IMAP 操作暂不可用；账户、日志和任务状态仍可查看。"
          style={{ marginBottom: 12 }}
        />
      )}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'accounts',
            label: '邮箱账户',
            children: (
              <Table<EmailAccount>
                rowKey="id"
                dataSource={accounts}
                pagination={false}
                locale={{ emptyText: '尚未绑定邮箱，绑定后可自动同步信用卡账单' }}
                columns={[
                  { title: '邮箱', dataIndex: 'email' },
                  { title: 'IMAP', key: 'imap', render: (_, r) => `${r.imapHost}:${r.imapPort}${r.tls ? ' (SSL)' : ''}` },
                  {
                    title: '上次同步',
                    dataIndex: 'lastSyncAt',
                    width: 160,
                    render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '从未'),
                  },
                  {
                    title: '启用',
                    dataIndex: 'enabled',
                    width: 80,
                    render: (v, r) => (
                      <Switch
                        checked={v}
                        aria-label={`${r.email} 邮箱同步${v ? '已启用' : '已停用'}`}
                        loading={toggling === r.id}
                        disabled={historyGate.blocked || toggling === r.id}
                        onChange={(e) => void toggleEnabled(r, e)}
                      />
                    ),
                  },
                  {
                    title: '操作',
                    key: 'op',
                    width: 460,
                    render: (_, r) => (
                      <Space>
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          icon={<CloudDownloadOutlined />}
                          loading={syncing === r.id}
                          disabled={historyGate.blocked || resyncing === r.id}
                          onClick={() => void sync(r.id)}
                        >
                          同步
                        </Button>
                        <Popconfirm
                          title="拉取全部历史邮件？"
                          description="不限时间拉取邮箱内全部历史账单邮件（已处理的自动跳过），用于初始化后补全历史账单。"
                          onConfirm={() => void startHistory(r)}
                        >
                          <Button
                            size="small"
                            icon={<DownloadOutlined />}
                            disabled={historyGate.blocked || syncing === r.id || resyncing === r.id}
                          >
                            拉取历史
                          </Button>
                        </Popconfirm>
                        <Popconfirm
                          title="重新同步该邮箱？"
                          description="将清除该账户已有同步日志、重置同步游标，并按同步天数范围重新拉取邮件。"
                          onConfirm={() => void resync(r.id)}
                        >
                          <Button
                            size="small"
                            icon={<HistoryOutlined />}
                            loading={resyncing === r.id}
                            disabled={historyGate.blocked || syncing === r.id}
                          >
                            重新同步
                          </Button>
                        </Popconfirm>
                        <Button
                          size="small"
                          disabled={historyGate.blocked}
                          onClick={() => {
                            openEditor(r);
                          }}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title={`解绑 ${r.email}？`}
                          description="解绑会删除该邮箱账户与全部同步日志，不会删除卡片和账单；依赖该账户或日志的历史交易明细将无法再实时读取。"
                          onConfirm={() => void remove(r.id)}
                        >
                          <Button
                            size="small"
                            danger
                            loading={removing === r.id}
                            disabled={historyGate.blocked || removing === r.id}
                          >
                            解绑
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'logs',
            label: '同步日志',
            children: (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Select
                    allowClear
                    placeholder="全部账户"
                    style={{ width: 220 }}
                    value={logFilter.accountId}
                    onChange={(v) => {
                      setLogPage(1);
                      setLogFilter((f) => ({ ...f, accountId: v }));
                    }}
                    options={accounts.map((a) => ({ value: a.id, label: a.email }))}
                  />
                  <Select
                    allowClear
                    placeholder="全部状态"
                    style={{ width: 140 }}
                    value={logFilter.status}
                    onChange={(v) => {
                      setLogPage(1);
                      setLogFilter((f) => ({ ...f, status: v }));
                    }}
                    options={Object.entries(STATUS_TAG).map(([value, v]) => ({ value, label: v.text }))}
                  />
                  <Checkbox
                    checked={showUnmatched}
                    onChange={(e) => {
                      setLogPage(1);
                      setShowUnmatched(e.target.checked);
                    }}
                  >
                    显示未匹配
                  </Checkbox>
                </Space>
                <Table<MailLogRow>
                  rowKey="id"
                  loading={logLoading}
                  dataSource={logs.items}
                  size="small"
                  pagination={{
                    current: logs.page,
                    pageSize: logs.pageSize,
                    total: logs.total,
                    onChange: setLogPage,
                    showTotal: (t) => `共 ${t} 条`,
                  }}
                  columns={[
                    {
                      title: '时间',
                      dataIndex: 'mailDate',
                      width: 150,
                      render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm'),
                    },
                    { title: '发件人', dataIndex: 'fromAddress', width: 200, ellipsis: true },
                    { title: '主题', dataIndex: 'subject', ellipsis: true },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 90,
                      render: (v) => <Tag color={STATUS_TAG[v]?.color}>{STATUS_TAG[v]?.text ?? v}</Tag>,
                    },
                    { title: '解析器', dataIndex: 'parserId', width: 90, render: (v) => v || '-' },
                    {
                      title: '错误',
                      dataIndex: 'error',
                      width: 200,
                      ellipsis: true,
                      render: (v) => (v ? <Typography.Text type="danger">{v}</Typography.Text> : '-'),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />

      {editing !== undefined && (
        <AccountForm
          initial={editing}
          onOk={submitAccount}
          onCancel={closeEditor}
          confirmLoading={saving}
          disabled={historyGate.blocked}
          draft={accountDraft}
          onDraftChange={setAccountDraft}
        />
      )}

      {historyAccount && (
        <Modal
          title={`历史拉取 - ${historyAccount.email}`}
          open={historyState != null || historyGate.phase === 'starting'}
          onCancel={() => {
            if (!historyState?.running) closeHistoryProgress();
          }}
          footer={
            historyState?.running ? null : (
              <Button type="primary" onClick={closeHistoryProgress}>
                知道了
              </Button>
            )
          }
          closable={!historyState?.running}
          mask={{ closable: false }}
        >
          {historyProgressContent}
        </Modal>
      )}
    </Page>
  );
}
