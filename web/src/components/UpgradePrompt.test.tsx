import { App } from 'antd';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpgradePlan, UpgradeTask } from '../api/types';
import UpgradePrompt from './UpgradePrompt';

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', () => ({ api: apiMocks }));
vi.mock('../responsive', () => ({ useResponsive: () => ({ isMobile: false }) }));

function task(key: string, title: string, mode: UpgradeTask['mode'] = 'optional'): UpgradeTask {
  return {
    key, title, mode, description: '修正当前显示，保留历史账单。', targetVersion: '0.4.1', order: 1,
    executeLabel: '现在执行', ignoreLabel: mode === 'optional' ? '忽略更新' : null,
    status: 'awaiting_decision', total: 2, processed: 0, succeeded: 0, unchanged: 0, failed: 0, error: null,
  };
}

function plan(tasks: UpgradeTask[]): UpgradePlan {
  return {
    id: 8, fromVersion: '0.4.0', toVersion: '0.4.2', status: 'awaiting_decision',
    hasRequired: tasks.some((item) => item.mode === 'required'), runtimeMode: 'optional_wait', error: null,
    tasks, migrations: tasks.map((item) => ({ ...item, summary: null })),
  };
}

describe('整批确认升级选择', () => {
  beforeEach(() => vi.clearAllMocks());

  it('多个可选项目只在底部确认一次，切换选择不发送请求', async () => {
    const current = plan([task('bill', '修正本期账单状态'), task('card', '修正卡片关系')]);
    current.migrations[0].summary = '平安银行 · 共 2 张卡的本期账单';
    current.migrations[1].summary = '工商银行 · 共 26 封已识别的历史账单邮件';
    current.migrations[1].description = '将从已绑定邮箱重新读取上述邮件，修正旧版未完整识别的主副卡关系。';
    current.tasks[0].ignoreWarning = '忽略后，本期仍可能显示「未取得账单」并产生多余提醒；收到下期账单后会正常处理。系统将不再提供本次迁移服务。';
    apiMocks.get.mockResolvedValue(current);
    apiMocks.post.mockResolvedValue({ ...current, status: 'executing' });
    const user = userEvent.setup();
    render(<App><UpgradePrompt /></App>);
    await screen.findByText('修正本期账单状态');
    expect(screen.getByText('平安银行 · 共 2 张卡的本期账单')).toBeTruthy();
    expect(screen.getByText('工商银行 · 共 26 封已识别的历史账单邮件')).toBeTruthy();
    expect(screen.getByText(/从已绑定邮箱重新读取上述邮件/)).toBeTruthy();
    expect(screen.queryByText(/招商银行|民生银行|华夏银行/)).toBeNull();
    expect(screen.queryByText(/等待决定期间|不再提供执行入口|忽略后/)).toBeNull();
    expect(screen.queryByRole('button', { name: '现在执行' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    const selection = within(screen.getByRole('radiogroup', { name: '修正本期账单状态' }));
    const options = selection.getAllByRole('radio');
    expect(options[0]).toBe(selection.getByRole('radio', { name: '忽略' }));
    expect(options[1]).toBe(selection.getByRole('radio', { name: '执行' }));
    expect(selection.queryByText('推荐')).toBeNull();
    expect((options[1] as HTMLInputElement).checked).toBe(true);
    await user.click(selection.getByText('忽略'));
    expect((selection.getByRole('radio', { name: '忽略' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(current.tasks[0].ignoreWarning);
    expect(screen.getByRole('radiogroup', { name: '修正本期账单状态' }).getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(apiMocks.post).not.toHaveBeenCalled();
    await user.click(selection.getByText('执行'));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(selection.getByText('忽略'));
    expect(screen.getByRole('alert').textContent).toContain('系统将不再提供本次迁移服务。');
    await user.click(screen.getByRole('button', { name: '确认并继续' }));

    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledWith('/api/upgrades/decisions', {
      planId: 8, decisions: [{ key: 'bill', action: 'ignore' }, { key: 'card', action: 'approve' }],
    });
  });

  it('必选项目不提供忽略，混合计划同一次确认', async () => {
    const current = plan([task('required', '修正必要数据', 'required'), task('optional', '修正本期账单状态')]);
    current.migrations.push({ key: 'silent', mode: 'silent', title: '后台静默修正', description: '不需要用户关心', targetVersion: '0.4.2', order: 2, total: 2, summary: '静默影响范围' });
    apiMocks.get.mockResolvedValue(current);
    apiMocks.post.mockResolvedValue({ ...current, status: 'executing' });
    const user = userEvent.setup();
    render(<App><UpgradePrompt /></App>);
    await screen.findByText('修正必要数据');
    expect(screen.queryByText(/后台静默修正|不需要用户关心|静默影响范围|自动更新/)).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(apiMocks.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认并继续' }));
    expect(apiMocks.post).toHaveBeenCalledWith('/api/upgrades/decisions', {
      planId: 8, decisions: [{ key: 'required', action: 'approve' }, { key: 'optional', action: 'approve' }],
    });
  });

  it('必选失败只能重试，提交失败保留选择供再次确认', async () => {
    const current = plan([{ ...task('required', '修正必要数据', 'required'), status: 'failed' }]);
    current.status = 'failed';
    apiMocks.get.mockResolvedValue(current);
    apiMocks.post.mockRejectedValue(new Error('连接失败，请重试'));
    const user = userEvent.setup();
    render(<App><UpgradePrompt /></App>);
    await screen.findByText('修正必要数据');
    expect(screen.queryByRole('radio')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^重\s*试$/ }));
    await screen.findByText('连接失败，请重试');
    await waitFor(() => expect(screen.getByRole('button', { name: /^重\s*试$/ }).hasAttribute('disabled')).toBe(false));
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
  });

  it('可选项目执行失败后忽略，说明已完成的修改不会撤回', async () => {
    const current = plan([{ ...task('optional', '修正卡片关系'), status: 'failed', processed: 1, succeeded: 1,
      ignoreWarning: '忽略后，未处理的历史账单会保留原有卡片关系；新账单仍会正常识别。系统将不再提供本次迁移服务。' }]);
    current.status = 'failed';
    apiMocks.get.mockResolvedValue(current);
    const user = userEvent.setup();
    render(<App><UpgradePrompt /></App>);
    await screen.findByText('修正卡片关系');
    await user.click(within(screen.getByRole('radiogroup', { name: '修正卡片关系' })).getByText('忽略'));
    expect(screen.getByRole('alert').textContent).toContain('已经完成的修改会保留');
    expect(screen.getByRole('alert').textContent).toContain(current.tasks[0].ignoreWarning);
    expect(screen.getByRole('alert').textContent).not.toContain('本次更新');
    expect(screen.getByRole('button', { name: '确认并继续' })).toBeTruthy();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it('只有静默项目时不出现弹窗，结束后也不提示用户', async () => {
    const current = plan([]);
    current.status = 'executing';
    current.migrations.push({ key: 'silent', mode: 'silent', title: '后台静默修正', description: '不需要用户关心', targetVersion: '0.4.2', order: 2, total: 2, summary: null });
    apiMocks.get.mockResolvedValueOnce(current).mockResolvedValue(null);
    const { container } = render(<App><UpgradePrompt /></App>);
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/系统升级已完成|后台静默修正/)).toBeNull();
    expect(container.querySelector('.upgrade-flow')).toBeNull();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it('确认时已经完成的修复也显示具体结果', async () => {
    const current = plan([task('repair', '修复账单金额错误与明细遗漏', 'required')]);
    apiMocks.get.mockResolvedValueOnce(current).mockResolvedValue({ version: '0.5.0', counts: {
      correctedBills: 2, addedBills: 1, addedTransactions: 3, correctedTransactions: 0, removedTransactions: 0,
      restoredRepayments: 1, fallbackMinimumBills: 0, unavailableMails: 0,
    }, incomplete: [] });
    apiMocks.post.mockResolvedValue(null);
    render(<App><UpgradePrompt /></App>);
    await screen.findByText('修复账单金额错误与明细遗漏');
    await userEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    expect(await screen.findByText('修正账单 2 笔')).toBeTruthy();
    expect(screen.getByText('补建账单 1 笔')).toBeTruthy();
  });

  function mailboxFailurePlan() {
    const current = plan([{ ...task('repair', '修复历史账单'), status: 'failed', failed: 2, succeeded: 4 }]);
    current.status = 'failed';
    current.runtimeMode = 'failed';
    current.mailboxFailures = [1, 2].map(id => ({ id, email: `mail${id}@example.test`, imapHost: 'imap.qq.com',
      imapPort: 993, tls: true, authUser: `mail${id}@example.test` }));
    return current;
  }

  it('明确邮箱失败时同时设置多个邮箱，保存只返回原弹窗，用户点重试才继续迁移', async () => {
    const current = mailboxFailurePlan();
    apiMocks.get.mockResolvedValue(current);
    apiMocks.put.mockResolvedValue({ ok: true });
    apiMocks.post.mockResolvedValue({ ...current, status: 'executing' });
    const user = userEvent.setup();
    render(<App><UpgradePrompt /></App>);
    const settings = await screen.findByRole('dialog', { name: '邮箱设置' });
    for (const id of [1, 2]) {
      const account = within(settings).getByRole('region', { name: `mail${id}@example.test` });
      await user.type(within(account).getByLabelText('授权码（留空则不修改）'), `synthetic-code-${id}`);
    }
    await user.click(within(settings).getByRole('button', { name: '完成设置' }));
    await screen.findByText('修复历史账单');
    expect(apiMocks.put).toHaveBeenCalledWith('/api/email/accounts/configurations', { accounts: current.mailboxFailures!.map(account => ({
      ...account, authPassword: `synthetic-code-${account.id}`,
    })) });
    expect(apiMocks.post).not.toHaveBeenCalled();
    expect(screen.queryByText('查看并重试')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^重\s*试$/ }));
    expect(apiMocks.post).toHaveBeenCalledWith('/api/upgrades/decisions', { planId: 8, decisions: [{ key: 'repair', action: 'approve' }] });
  });

  it('邮箱验证失败保留所有输入，取消返回迁移弹窗后仍能再次设置邮箱', async () => {
    apiMocks.get.mockResolvedValue(mailboxFailurePlan());
    apiMocks.put.mockRejectedValue(new Error('mail2@example.test 无法连接'));
    const user = userEvent.setup();
    render(<App><UpgradePrompt /></App>);
    const settings = await screen.findByRole('dialog', { name: '邮箱设置' });
    await user.click(within(settings).getByRole('button', { name: '完成设置' }));
    expect(await screen.findByText('mail2@example.test 无法连接')).toBeTruthy();
    expect(apiMocks.post).not.toHaveBeenCalled();
    await user.click(within(settings).getByRole('button', { name: /^取\s*消$/ }));
    await screen.findByText('修复历史账单');
    await user.click(screen.getByRole('button', { name: '设置邮箱' }));
    expect(await screen.findByRole('dialog', { name: '邮箱设置' })).toBeTruthy();
  });
});
