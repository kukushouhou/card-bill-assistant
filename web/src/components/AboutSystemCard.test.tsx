import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { AppNameContext, AppVersionContext } from '../appName';
import AboutSystemCard from './AboutSystemCard';
const get = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('../api/client', () => ({ api: { get } }));

describe('系统版本与升级结果', () => {
  it('显示共享的运行版本和自定义系统名，检查更新直接链接发布页', () => {
    render(<App><AppNameContext.Provider value="我的账单"><AppVersionContext.Provider value="0.5.0"><AboutSystemCard /></AppVersionContext.Provider></AppNameContext.Provider></App>);
    expect(screen.getByRole('heading', { name: '我的账单' })).toBeTruthy(); expect(screen.getByText('版本 v0.5.0')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: '检查更新' }).getAttribute('href')).toBe('https://github.com/kukushouhou/card-bill-assistant/releases');
    expect(get.mock.calls.every(([url]) => url === '/api/upgrades/latest-result')).toBe(true);
  });
  it('版本未取得时不猜测，并明确显示未补齐记录', async () => {
    get.mockResolvedValueOnce({ version: '0.5.0', counts: { correctedBills: 1, addedBills: 0, addedTransactions: 1,
      correctedTransactions: 0, removedTransactions: 0, restoredRepayments: 0, fallbackMinimumBills: 1, unavailableMails: 1 }, incomplete: [{ bankName: '中信银行', billCount: 1 }] });
    render(<App><AboutSystemCard /></App>);
    expect(screen.getByText('版本信息暂未获取')).toBeTruthy();
    expect(await screen.findByText('1 封邮件的明细未补齐')).toBeTruthy();
    expect(screen.getByText(/最低还款已按修正后的应还总额恢复/)).toBeTruthy();
  });
});
