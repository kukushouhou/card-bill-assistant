import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, App, Button, Card, ConfigProvider, Form, Input, InputNumber, Segmented, Select, Space, Table, Tag } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import BusinessFlow from '../components/BusinessFlow';
import AmountSummary from '../components/AmountSummary';
import { prepareSkin, skinTheme } from './runtime';
import { SkinAssetsContext } from './SkinAssets';
import { ProfileOutlined, CreditCardOutlined, SettingOutlined } from './icons';
import type { SkinDescriptor, SkinVariant } from './types';
import './skins.css';
import '../components/agenda.css';

function Fixture({ mobile }: { mobile: boolean }) {
  const [paid, setPaid] = useState(false);
  const records = [{ key: 'one', bank: '交通银行 · 0988', amount: '¥1,280.00' }, { key: 'two', bank: '中信银行 · 8855', amount: 'USD $12.60' }];
  return <div className="app-shell skin-preview-fixture">
    <header className="skin-fixture-header" data-skin-slot="header"><strong data-skin-slot="brand"><CreditCardOutlined /> 守候</strong><Space><ProfileOutlined /><SettingOutlined /></Space></header>
    <main className={'page ' + (mobile ? 'page-mobile' : 'page-desktop')}>
      <h2>账单中心</h2><Segmented options={['待处理', '今日应提醒', '未来 30 天', '历史']} block />
      <div style={{ margin: '20px 0' }}><AmountSummary title="待还合计" amounts={[{ currency: 'CNY', amount: 1280 }, { currency: 'USD', amount: 12.6 }]} metrics={[{ count: 2, label: '笔账单' }]} /></div>
      {mobile ? <div className="agenda-mobile-list">{records.map(row => <article className="agenda-mobile-row" key={row.key}><div className="agenda-row-body"><div className="agenda-mobile-top"><strong>{row.bank}</strong><span>8月</span></div><div className="agenda-mobile-main"><strong className="agenda-amount">{row.amount}</strong><Tag color={paid ? 'green' : 'orange'}>{paid ? '已还清' : '待还'}</Tag></div><div className="agenda-dates">出账 8月10日 · 还款 9月4日</div></div><div className="agenda-row-actions"><Button onClick={() => setPaid(!paid)}>{paid ? '调整还款' : '还款'}</Button></div></article>)}</div> : <Table rowKey="key" dataSource={records} pagination={false} columns={[{ title: '银行 / 卡尾', dataIndex: 'bank' }, { title: '账期', render: () => <span className="agenda-period"><Button className="agenda-period-link" type="link">8月</Button></span> }, { title: '待还金额', dataIndex: 'amount' }, { title: '状态', render: () => <Tag color={paid ? 'green' : 'orange'}>{paid ? '已还清' : '待还'}</Tag> }, { title: '操作', render: () => <Button onClick={() => setPaid(!paid)}>还款</Button> }]} />}
      <Card title="提醒设置" style={{ marginTop: 20 }}><Form layout="vertical" initialValues={{ name: '每月房租', amount: 2800, day: '每月 5 日' }}><div className="skin-fixture-form" style={{ gridTemplateColumns: mobile ? '1fr' : '1fr 1fr' }}><Form.Item name="name" label="名称"><Input /></Form.Item><Form.Item name="day" label="日期"><Select options={['每月 5 日', '每月 10 日'].map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="amount" label="金额"><InputNumber style={{ width: '100%' }} /></Form.Item></div><Space><Button type="primary">保存</Button><Button>取消</Button><Button danger>删除</Button></Space></Form></Card>
    </main>
  </div>;
}

export default function SkinPreview({ skin, onClose, onApply, applying }: { skin: SkinDescriptor; onClose: () => void; onApply: () => Promise<void>; applying: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const variant = (device + '-' + mode) as SkinVariant;
  useEffect(() => {
    if (!doc) return;
    const copyBase = () => {
      doc.querySelectorAll('[data-preview-base]').forEach(node => node.remove());
      const anchor = doc.querySelector('link[data-skin-dynamic]');
      document.querySelectorAll('style, link[rel="stylesheet"]:not([data-skin-dynamic])').forEach(node => {
        const clone = node.cloneNode(true) as HTMLElement; clone.dataset.previewBase = 'true'; doc.head.insertBefore(clone, anchor);
      });
    };
    copyBase(); const observer = new MutationObserver(copyBase); observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [doc]);
  useEffect(() => {
    if (!doc) return;
    let canceled = false; let prepared: Awaited<ReturnType<typeof prepareSkin>> | undefined;
    setReady(false); setError('');
    prepareSkin(skin, variant, doc).then(result => { prepared = result; if (canceled) result.dispose(); else { result.activate(); setReady(true); } }).catch(e => { if (!canceled) setError(e.message); });
    return () => { canceled = true; prepared?.dispose(); };
  }, [doc, skin, variant]);
  return <BusinessFlow title={'预览 · ' + skin.manifest.name} width={1240} onClose={() => { if (!applying) onClose(); }} footer={<Space><Button disabled={applying} onClick={onClose}>取消</Button><Button type="primary" disabled={!ready} loading={applying} onClick={() => void onApply()}>应用皮肤</Button></Space>}>
    <div className="skin-preview-controls"><Segmented value={device} onChange={setDevice} options={[{ value: 'desktop', label: '电脑' }, { value: 'mobile', label: '手机' }]} /><Segmented value={mode} onChange={setMode} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} /></div>
    {error && <Alert type="error" title={error} />}
    <div className="skin-preview-viewport"><iframe ref={frame} title="皮肤效果预览" sandbox="allow-same-origin" srcDoc={'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="skin-preview-root"></div></body></html>'} onLoad={() => setDoc(frame.current?.contentDocument ?? null)} style={{ width: device === 'mobile' ? 390 : 1100, height: 620 }} /></div>
    {doc?.getElementById('skin-preview-root') && createPortal(<SkinAssetsContext.Provider value={{ skin, variant }}><ConfigProvider button={{ autoInsertSpace: false }} locale={zhCN} theme={skinTheme(skin.manifest.variants[variant].tokens, mode === 'dark')} getPopupContainer={() => doc.body}><App><Fixture mobile={device === 'mobile'} /></App></ConfigProvider></SkinAssetsContext.Provider>, doc.getElementById('skin-preview-root')!)}
  </BusinessFlow>;
}
