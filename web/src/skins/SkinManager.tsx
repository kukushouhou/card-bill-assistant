import { useRef, useState } from 'react';
import { Alert, App, Button, Card, Empty, Skeleton, Space, Tag } from 'antd';
import { api } from '../api/client';
import { useResource } from '../lib/useResource';
import BusinessFlow from '../components/BusinessFlow';
import { ColorModeSwitch, useSkin } from './SkinProvider';
import SkinPreview from './SkinPreview';
import type { SkinDescriptor } from './types';
import './skins.css';

export default function SkinManager() {
  const { message } = App.useApp();
  const appearance = useSkin();
  const resource = useResource<{ items: SkinDescriptor[]; active: SkinDescriptor }>('/api/skins');
  const [preview, setPreview] = useState<SkinDescriptor | null>(null);
  const [deleting, setDeleting] = useState<SkinDescriptor | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const execute = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); } catch (e) { message.error(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { lock.current = false; setBusy(false); }
  };
  const active = (skin: SkinDescriptor) => skin.manifest.id === appearance.skin.manifest.id && skin.manifest.version === appearance.skin.manifest.version;
  const defaultSkin = resource.data?.items.find(item => item.manifest.id === 'modern');
  const apply = (skin: SkinDescriptor) => execute(async () => { await appearance.apply(skin); message.success('已应用“' + skin.manifest.name + '”'); setPreview(null); void resource.refresh(); });
  return <Card title="外观与皮肤" className="settings-card skin-manager" data-skin-slot="skin-manager">
    <div className="skin-manager-toolbar"><ColorModeSwitch /><Space wrap><Button disabled={busy || appearance.busy} onClick={() => input.current?.click()}>导入皮肤包</Button><Button disabled={!defaultSkin || busy || appearance.busy} onClick={() => { if (defaultSkin) void apply(defaultSkin); }}>恢复默认</Button></Space></div>
    <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) void execute(async () => {
        if (file.size > 32 * 1024 * 1024) throw new Error('皮肤包不能超过 32 MiB');
        const result = await api.upload<{ skin: SkinDescriptor; exists: boolean }>('/api/skins/import', file);
        message.success(result.exists ? '该皮肤版本已存在' : '皮肤已导入，可预览后应用'); await resource.refresh(); setPreview(result.skin);
      });
    }} />
    {resource.error && <Alert type="error" title={resource.error} action={<Button onClick={() => void resource.refresh()}>重试</Button>} />}
    {appearance.error && <Alert type="warning" title={appearance.error} />}
    {!resource.data && resource.loading && <Skeleton active />}
    {resource.data?.items.length === 0 && <Empty description="暂无可用皮肤" />}
    <div className="skin-library">{resource.data?.items.map(skin => <article className="skin-library-item" key={skin.manifest.id + '@' + skin.manifest.version}>
      <button className="skin-library-preview" disabled={skin.available === false} onClick={() => setPreview(skin)} aria-label={'预览' + skin.manifest.name}><img src={skin.baseUrl + skin.manifest.previews[appearance.variant]} alt={skin.manifest.name + '预览'} loading="lazy" /></button>
      <div className="skin-library-info"><strong>{skin.manifest.name}</strong><span>{skin.manifest.version}</span>{active(skin) ? <Tag color="blue">正在使用</Tag> : skin.builtin ? <Tag>内置</Tag> : null}</div>
      <p>{skin.manifest.description}</p>{skin.available === false && <Alert type="warning" title="皮肤资源不可用，可删除后导入新版本" />}
      <Space wrap><Button disabled={skin.available === false} onClick={() => setPreview(skin)}>预览</Button><Button type={active(skin) ? 'default' : 'primary'} disabled={skin.available === false || active(skin) || busy || appearance.busy} onClick={() => void apply(skin)}>应用</Button><Button disabled={skin.available === false} href={'/api/skins/' + skin.manifest.id + '/' + skin.manifest.version + '/export'} download>导出</Button>{!skin.builtin && <Button danger disabled={busy || appearance.busy} onClick={() => setDeleting(skin)}>删除</Button>}</Space>
    </article>)}</div>
    {preview && <SkinPreview skin={preview} applying={busy || appearance.busy} onClose={() => setPreview(null)} onApply={() => apply(preview)} />}
    {deleting && <BusinessFlow title={active(deleting) ? '恢复默认并删除皮肤' : '删除皮肤'} onClose={() => { if (!busy) setDeleting(null); }} width={560} footer={<Space><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button danger type="primary" loading={busy} onClick={() => void execute(async () => {
      const restoreDefault = active(deleting);
      if (restoreDefault) { if (!defaultSkin) throw new Error('默认皮肤暂不可用'); await appearance.apply(defaultSkin); }
      await api.delete('/api/skins/' + deleting.manifest.id + '/' + deleting.manifest.version, { restoreDefault });
      setDeleting(null); await resource.refresh(); message.success('皮肤已删除');
    })}>{active(deleting) ? '恢复默认并删除' : '删除皮肤'}</Button></Space>}><p>删除“{deleting.manifest.name}” {deleting.manifest.version}？{active(deleting) ? '将先恢复“克制现代”皮肤。' : ''}明暗偏好会保留。</p></BusinessFlow>}
  </Card>;
}
