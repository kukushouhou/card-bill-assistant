import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { AppNameContext, AppVersionContext } from '../appName';
import AboutSystemCard from './AboutSystemCard';
const get = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('../api/client', () => ({ api: { get } }));

describe('关于本系统', () => {
  it('显示共享的运行版本和自定义系统名，检查更新直接链接发布页', () => {
    render(<App><AppNameContext.Provider value="我的账单"><AppVersionContext.Provider value="0.5.0"><AboutSystemCard /></AppVersionContext.Provider></AppNameContext.Provider></App>);
    expect(screen.getByRole('heading', { name: '我的账单' })).toBeTruthy(); expect(screen.getByText('版本 v0.5.0')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: '检查更新' }).getAttribute('href')).toBe('https://github.com/kukushouhou/card-bill-assistant/releases');
    expect(screen.getByText('本系统不会代扣还款，请以银行账单为准。')).toBeTruthy();
    expect(screen.getByText('卡信息加密保存，PIN 不留存，请妥善保管。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看使用文档' }).getAttribute('href')).toMatch(/#readme$/);
    expect(screen.getByRole('link', { name: '反馈问题' }).getAttribute('href')).toMatch(/\/issues$/);
    expect(get).not.toHaveBeenCalled();
  });
  it('版本未取得时不猜测，不读取或展示迁移结果', () => {
    render(<App><AboutSystemCard /></App>);
    expect(screen.getByText('版本信息暂未获取')).toBeTruthy();
    expect(screen.queryByText(/账单修复结果/)).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
