import { Radio } from 'antd';
import { useResource } from '../lib/useResource';
import type { SkinDescriptor } from './types';
import { useSkin } from './SkinProvider';
import './skins.css';

export default function BuiltinSkinPicker({ value, onChange, disabled = false }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const { data } = useResource<SkinDescriptor[]>('/api/skins/builtins');
  const { variant } = useSkin();
  return <section className="builtin-skin-picker"><h3>选择皮肤</h3><Radio.Group aria-label="皮肤" disabled={disabled} value={value} onChange={event => onChange(event.target.value)} className="builtin-skin-options">
    {(data ?? []).map(skin => <Radio.Button className="builtin-skin-option" key={skin.manifest.id} value={skin.manifest.id}>
      <div className="builtin-skin-content">
        <img className="builtin-skin-preview" src={skin.baseUrl + skin.manifest.previews[variant]} alt="" />
        <div><div className="builtin-skin-caption"><strong>{skin.manifest.name}</strong>{value === skin.manifest.id && <span>已选择</span>}</div><p>{skin.manifest.description}</p></div>
      </div>
    </Radio.Button>)}
    {!data && <><Radio.Button value="modern">克制现代</Radio.Button><Radio.Button value="warm-ledger">温润账本</Radio.Button></>}
  </Radio.Group></section>;
}
