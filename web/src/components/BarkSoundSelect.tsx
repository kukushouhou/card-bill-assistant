import { useEffect, useState } from 'react';
import { Input, Select } from 'antd';
const IMPORTED = '__imported_sound__';

/** 手机导入的名称只有明确选择后才允许填写。 */
export default function BarkSoundSelect({ value, onChange, options, id }: {
  value?: string; onChange?: (value: string | undefined) => void;
  options: Array<{ value: string; label: string }>; id?: string;
}) {
  const [imported, setImported] = useState(Boolean(value && !options.some(option => option.value === value)));
  useEffect(() => {
    if (value) setImported(!options.some(option => option.value === value));
  }, [value, options]);
  return <div className="bark-sound-select">
    <Select id={id} showSearch optionFilterProp="label" value={imported ? IMPORTED : value ?? ''}
      options={[{ value: '', label: '默认铃声' }, ...options, { value: IMPORTED, label: '使用手机已导入的铃声' }]}
      onChange={next => { setImported(next === IMPORTED); onChange?.(next === IMPORTED || next === '' ? undefined : next); }} />
    {imported && <>
      <Input aria-label="已导入铃声名称" value={value ?? ''} placeholder="粘贴 Bark 中复制的铃声名称" onChange={event => onChange?.(event.target.value)} />
      <div className="notification-field-note">先在目标手机的 Bark 中导入音频，再复制名称。</div>
    </>}
  </div>;
}
