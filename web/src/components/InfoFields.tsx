import type { ReactNode } from 'react';
import './info-fields.css';

export interface InfoField {
  label: string;
  value: ReactNode;
  tone?: 'warning' | 'danger' | 'success';
}

/** 只读信息用明确的名称与内容配对，避免将多个业务字段拼成一句话。 */
export default function InfoFields({ items, label, plain = false, className = '' }: {
  items: InfoField[]; label?: string; plain?: boolean; className?: string;
}) {
  return <dl className={['info-fields', plain ? 'info-fields-plain' : '', className].filter(Boolean).join(' ')} aria-label={label} data-skin-slot="facts">
    {items.map(item => <div className={'info-field' + (item.tone ? ' info-field-' + item.tone : '')} key={item.label}>
      <dt>{item.label}</dt><dd>{item.value}</dd>
    </div>)}
  </dl>;
}
