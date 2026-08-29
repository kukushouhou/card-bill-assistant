import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api/client';
import type { EmailAccount, HistorySyncState } from './api/types';

export type HistoryGatePhase = 'idle' | 'starting' | 'running' | 'unknown';

export interface HistoryTaskFact {
  account: EmailAccount;
  state: HistorySyncState;
}

interface HistoryGateValue {
  phase: HistoryGatePhase;
  blocked: boolean;
  blockedReason: string;
  accounts: EmailAccount[];
  runningTasks: HistoryTaskFact[];
  focusedTask: HistoryTaskFact | null;
  progressUnavailable: boolean;
  scan: () => Promise<HistoryTaskFact[]>;
  startHistory: (account: EmailAccount) => Promise<HistorySyncState>;
  mayRunRestrictedAction: () => boolean;
  dismissFocusedTask: () => void;
}

const HistoryGateContext = createContext<HistoryGateValue | null>(null);

function isBlankHistoryState(state: HistorySyncState) {
  return !state.running && !state.startedAt && !state.finishedAt && state.total === 0 && !state.error;
}

/**
 * 当前 SPA 会话级 IMAP 用户操作门禁。
 * 它组合既有账户与进度接口，不声称提供服务端、跨页签或定时任务全局锁。
 */
export function HistoryGateProvider({ children }: { children: ReactNode }) {
  const [phase, setPhaseState] = useState<HistoryGatePhase>('unknown');
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [runningTasks, setRunningTasks] = useState<HistoryTaskFact[]>([]);
  const [focusedTask, setFocusedTask] = useState<HistoryTaskFact | null>(null);
  const [progressUnavailable, setProgressUnavailable] = useState(false);
  const phaseRef = useRef<HistoryGatePhase>('unknown');
  const scanInFlight = useRef<Promise<HistoryTaskFact[]> | null>(null);
  const scanGeneration = useRef(0);
  const observedRunning = useRef(false);
  const focusedAccountId = useRef<number | null>(null);

  const setPhase = useCallback((next: HistoryGatePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const scan = useCallback(() => {
    if (scanInFlight.current) return scanInFlight.current;
    const generation = scanGeneration.current;

    const pending = (async () => {
      try {
        const nextAccounts = await api.get<EmailAccount[]>('/api/email/accounts');
        const states = await Promise.all(
          nextAccounts.map(async (account) => ({
            account,
            state: await api.get<HistorySyncState>(`/api/email/accounts/${account.id}/history-sync`),
          })),
        );
        const active = states.filter((item) => item.state.running);
        if (generation !== scanGeneration.current) return active;
        setAccounts(nextAccounts);
        setRunningTasks(active);

        if (active.length > 0) {
          observedRunning.current = true;
          setProgressUnavailable(false);
          setPhase('running');
        } else {
          if (observedRunning.current && states.every((item) => isBlankHistoryState(item.state))) {
            setProgressUnavailable(true);
          }
          // 启动请求尚未给出结论时，空扫描可能只是抢在服务端建任务之前返回，不能提前解锁。
          if (phaseRef.current !== 'starting') setPhase('idle');
        }

        const focusId = focusedAccountId.current;
        if (focusId != null) {
          const nextFocus = states.find((item) => item.account.id === focusId) ?? null;
          if (nextFocus) setFocusedTask(nextFocus);
        }
        return active;
      } catch (error) {
        if (generation === scanGeneration.current) setPhase('unknown');
        throw error;
      }
    })().finally(() => {
      if (scanInFlight.current === pending) scanInFlight.current = null;
    });

    scanInFlight.current = pending;
    return pending;
  }, [setPhase]);

  useEffect(() => {
    void scan().catch(() => undefined);
  }, [scan]);

  useEffect(() => {
    if (phase === 'idle') return;
    const timer = window.setInterval(() => {
      void scan().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [phase, scan]);

  const startHistory = useCallback(
    async (account: EmailAccount) => {
      if (phaseRef.current !== 'idle') throw new Error('历史拉取进行中');
      // 使启动前已经在途的扫描失效，并允许后续恢复扫描使用新一代请求。
      scanGeneration.current += 1;
      scanInFlight.current = null;
      focusedAccountId.current = account.id;
      setFocusedTask(null);
      setProgressUnavailable(false);
      setPhase('starting');
      try {
        const state = await api.post<HistorySyncState>(`/api/email/accounts/${account.id}/history-sync`);
        observedRunning.current = true;
        const task = { account, state };
        setFocusedTask(task);
        setRunningTasks(state.running ? [task] : []);
        if (state.running) setPhase('running');
        else {
          setPhase('unknown');
          await scan();
        }
        return state;
      } catch (error) {
        setPhase('unknown');
        await scan().catch(() => undefined);
        throw error;
      }
    },
    [scan, setPhase],
  );

  const dismissFocusedTask = useCallback(() => {
    if (focusedTask?.state.running) return;
    focusedAccountId.current = null;
    setFocusedTask(null);
  }, [focusedTask]);

  const value = useMemo<HistoryGateValue>(
    () => ({
      phase,
      blocked: phase !== 'idle',
      blockedReason: phase === 'unknown' ? '正在确认历史拉取状态' : '历史拉取进行中',
      accounts,
      runningTasks,
      focusedTask,
      progressUnavailable,
      scan,
      startHistory,
      mayRunRestrictedAction: () => phaseRef.current === 'idle',
      dismissFocusedTask,
    }),
    [accounts, dismissFocusedTask, focusedTask, phase, progressUnavailable, runningTasks, scan, startHistory],
  );

  return <HistoryGateContext.Provider value={value}>{children}</HistoryGateContext.Provider>;
}

export function useHistoryGate() {
  const value = useContext(HistoryGateContext);
  if (!value) throw new Error('useHistoryGate 必须在 HistoryGateProvider 内使用');
  return value;
}
