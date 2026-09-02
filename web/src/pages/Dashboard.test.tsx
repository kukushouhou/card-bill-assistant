import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSummary } from '../api/types';
import { MobileShellContext } from '../components/MobilePrimitives';
import Dashboard from './Dashboard';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const responsiveMocks = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  api: apiMocks,
}));

vi.mock('../responsive', () => ({
  useResponsive: () => ({ isMobile: responsiveMocks.isMobile, mode: responsiveMocks.isMobile ? 'mobile' : 'desktop' }),
}));

vi.mock('../historyGate', () => ({
  useHistoryGate: () => ({
    blocked: false,
    blockedReason: null,
    mayRunRestrictedAction: () => true,
  }),
}));

vi.mock('../components/TrendChart', () => ({
  default: () => null,
}));

vi.mock('../components/MarkPaidModal', () => ({
  default: () => null,
}));

vi.mock('../components/MobilePrimitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/MobilePrimitives')>();
  return {
    ...actual,
    MobilePullToRefresh: ({ children }: { children: unknown }) => children,
  };
});

const summary: DashboardSummary = {
  date: '2026-09-02T00:00:00.000+08:00',
  cards: { total: 3, active: 3, withSecret: 0 },
  currentPeriod: {
    period: '2026-09',
    bills: 3,
    unpaidCount: 3,
    unpaidTotal: 0,
    unknownAmountCount: 3,
    annualFeeCount: 0,
    annualFeeTotal: 0,
    currency: 'CNY',
    totalsByCurrency: [{ currency: 'CNY', unpaidCount: 3, unpaidTotal: 0, annualFeeTotal: 0 }],
  },
  annualFeeNotice: null,
  upcoming14d: { dueCount: 3, statementCount: 0, feeCount: 0, customCount: 0 },
  email: { total: 0, enabled: 0, lastSyncAt: null },
  customs: { total: 0, enabled: 0 },
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <App>
        <MobileShellContext.Provider
          value={{
            flow: null,
            registerFlow: () => () => undefined,
            navigateFromFlow: () => undefined,
          }}
        >
          <Dashboard />
        </MobileShellContext.Provider>
      </App>
    </MemoryRouter>,
  );
}

describe('仪表盘当前待还标题', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responsiveMocks.isMobile = false;
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/dashboard/summary') return summary;
      if (path === '/api/reminders/todos') return { items: [] };
      if (path.startsWith('/api/reminders/upcoming')) return { items: [] };
      if (path.startsWith('/api/bills/trend')) {
        return { months: 6, currency: 'CNY', currencies: ['CNY'], items: [] };
      }
      throw new Error(path);
    });
  });

  it('桌面端标题固定为当前待还，不再拼接账期', async () => {
    renderDashboard();
    expect(await screen.findByText('当前待还')).toBeTruthy();
    expect(screen.queryByText('本期待还')).toBeNull();
    expect(screen.queryByText('2026-09 期未还')).toBeNull();
    expect(screen.getByText('笔待还')).toBeTruthy();
  });

  it('移动端标题固定为当前待还', async () => {
    responsiveMocks.isMobile = true;
    renderDashboard();
    expect(await screen.findByText('当前待还')).toBeTruthy();
    expect(screen.queryByText('本期待还')).toBeNull();
    expect(await screen.findByText('3 笔')).toBeTruthy();
  });
});
