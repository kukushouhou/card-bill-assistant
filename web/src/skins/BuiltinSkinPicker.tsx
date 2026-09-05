import { Radio } from 'antd';
import { useResource } from '../lib/useResource';
import type { SkinDescriptor } from './types';
import './skins.css';

export default function BuiltinSkinPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data } = useResource<SkinDescriptor[]>('/api/skins/builtins');
  return <section style={{ marginTop: 24 }}><h3>选择皮肤</h3><Radio.Group value={value} onChange={event => onChange(event.target.value)} className="skin-library">
    {(data ?? []).map(skin => <Radio.Button key={skin.manifest.id} value={skin.manifest.id} style={{ height: 'auto', padding: 12, borderRadius: 12 }}><img src={skin.baseUrl + skin.manifest.previews['desktop-light']} alt="" style={{ display: 'block', width: '100%', maxWidth: 260, borderRadius: 8 }} /><strong>{skin.manifest.name}</strong></Radio.Button>)}
    {!data && <><Radio.Button value="modern">克制现代</Radio.Button><Radio.Button value="warm-ledger">温润账本</Radio.Button></>}
  </Radio.Group></section>;
}
