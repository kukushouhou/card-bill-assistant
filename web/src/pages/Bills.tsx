import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, App, Button, Input, Segmented, Select, Space } from 'antd';
import { FilterOutlined, ProfileOutlined, SettingOutlined, ThunderboltOutlined } from '../skins/icons';
import { Popup } from 'antd-mobile';
import { api } from '../api/client';
import type { AgendaView, CardRow } from '../api/types';
import { Page } from '../components/Layout';
import { AgendaPage } from '../components/AgendaList';
import ReminderSettings from '../components/ReminderSettings';
import BillStatistics from '../components/BillStatistics';
import { useResource } from '../lib/useResource';
import { useResponsive } from '../responsive';
import { useHistoryGate } from '../historyGate';

const views = [{ value: 'open', label: '待处理' }, { value: 'today', label: '今日应提醒' }, { value: 'upcoming', label: '未来 30 天' }, { value: 'history', label: '历史' }];
export default function Bills() {
  const { isMobile } = useResponsive();
  const { message } = App.useApp();
  const { mayRunRestrictedAction, blockedReason } = useHistoryGate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const queryText = params.get('q') ?? '';
  useEffect(() => setSearch(queryText), [queryText]);
  const view = (views.some(item => item.value === params.get('view')) ? params.get('view') : 'open') as AgendaView;
  const [settings, setSettings] = useState(false);
  const [stats, setStats] = useState(false);
  const [filters, setFilters] = useState(false);
  const [revision, setRevision] = useState(0);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ pushed: number; skipped: number; failed: number }>();
  const [runError, setRunError] = useState('');
  const lock = useRef(false);
  const cards = useResource<CardRow[]>('/api/cards');
  const update = (values: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    next.delete('page'); setParams(next, { replace: true });
  };
  const query = new URLSearchParams(params); query.set('view', view);
  const scope = new URLSearchParams();
  ['cardId', 'cardIds', 'bank'].forEach(key => { const value = params.get(key); if (value) scope.set(key, value); });
  const fields = <div className="agenda-filters">
    <Select aria-label="银行" placeholder="全部银行" allowClear value={params.get('bank') ?? undefined}
      options={[...new Set(cards.data?.map(card => card.bankName))].map(value => ({ value, label: value }))} onChange={bank => update({ bank, cardId: undefined, cardIds: undefined })} />
    <Select aria-label="卡片" placeholder="全部卡片" allowClear showSearch optionFilterProp="label" value={params.get('cardId') ? Number(params.get('cardId')) : undefined}
      options={cards.data?.filter(card => !params.get('bank') || card.bankName === params.get('bank')).map(card => ({ value: card.id, label: card.bankName + '（' + card.displayLast4 + '）' }))} onChange={id => update({ cardId: id ? String(id) : undefined, cardIds: undefined })} />
    <Select aria-label="记录类型" placeholder="全部类型" allowClear value={params.get('kind') ?? undefined} onChange={kind => update({ kind })} options={[
      { value: 'credit_bill', label: '信用卡账单' }, { value: 'fixed_bill', label: '固定账单' }, { value: 'dynamic_bill', label: '动态账单' }, { value: 'general', label: '常规提醒' }, { value: 'statement', label: '出账提醒' }, { value: 'fee', label: '年费提醒' }, { value: 'repayment', label: '还款提醒' },
    ]} />
    <Input.Search aria-label="搜索账单和提醒" placeholder="搜索银行、卡尾或提醒" allowClear value={search} onChange={event => setSearch(event.target.value)} onSearch={q => update({ q: q.trim() })} />
    <Button onClick={() => { setSearch(''); setParams({ view }, { replace: true }); }}>清除筛选</Button>
  </div>;
  const changed = () => setRevision(value => value + 1);
  const run = async () => {
    if (lock.current) return;
    if (!mayRunRestrictedAction()) { message.warning(blockedReason); return; }
    lock.current = true; setRunning(true); setRunError('');
    try { setRunResult(await api.post('/api/jobs/reminders/run')); changed(); }
    catch (e) { setRunError(e instanceof Error ? e.message : '推送失败，请重试'); }
    finally { lock.current = false; setRunning(false); }
  };
  return <Page title="账单中心" className="bill-center">
    <div className="agenda-toolbar agenda-navigation">
      <Segmented block={isMobile} options={views} value={view} onChange={value => update({ view: String(value) })} />
      {isMobile && <Button icon={<FilterOutlined />} onClick={() => setFilters(true)}>筛选</Button>}
      <Space wrap className="agenda-settings-launch"><Button icon={<ProfileOutlined />} onClick={() => setStats(true)}>账单统计</Button><Button icon={<SettingOutlined />} onClick={() => setSettings(true)}>提醒设置</Button></Space>
    </div>
    {!isMobile && fields}
    {view === 'today' && <div className="agenda-toolbar"><Button icon={<ThunderboltOutlined />} loading={running} onClick={() => void run()}>立即推送今日提醒</Button>{runResult && <span role="status">已推送 {runResult.pushed} 条 · 已推送过 {runResult.skipped} 条{runResult.failed ? ' · 失败 ' + runResult.failed + ' 条' : ''}</span>}{runError && <Alert type="error" title={runError} />}</div>}
    <AgendaPage query={query.toString()} revision={revision} />
    <Popup visible={filters} position="bottom" closeOnMaskClick onClose={() => setFilters(false)} bodyClassName="transaction-filter-sheet"><h3 style={{ padding: '16px 20px 0' }}>筛选账单</h3>{fields}<Button type="primary" block style={{ marginBottom: 20 }} onClick={() => setFilters(false)}>查看结果</Button></Popup>
    {settings && <ReminderSettings onClose={() => setSettings(false)} onChanged={changed} />}
    {stats && <BillStatistics scope={scope.toString()} onClose={() => setStats(false)} />}
  </Page>;
}
