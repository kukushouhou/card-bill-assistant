import { Radio, Typography } from 'antd';
import type { OverdueBasis } from '../api/types';
import './overdue-basis.css';

const OPTIONS: Array<{ value: OverdueBasis; label: string; description: string }> = [
  {
    value: 'all',
    label: '未全额还清',
    description: '只要没还清应还金额就算逾期，已还最低的账单也会继续提醒',
  },
  {
    value: 'minimum',
    label: '未还最低还款额',
    description: '已还够最低还款额的账单不算逾期，不再提醒',
  },
];

/** 「逾期提醒」口径选择控件：设置页、安装向导与升级提示弹窗共用，只负责选择，不含保存逻辑。 */
export default function OverdueBasisRadio({ value, onChange, disabled = false, name }: {
  value: OverdueBasis;
  onChange: (value: OverdueBasis) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <Radio.Group
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      name={name}
      className="overdue-basis-radio"
    >
      {OPTIONS.map((option) => (
        <Radio key={option.value} value={option.value}>
          <span className="overdue-basis-option">
            <span className="overdue-basis-label">{option.label}</span>
            <Typography.Text type="secondary" className="overdue-basis-description">
              {option.description}
            </Typography.Text>
          </span>
        </Radio>
      ))}
    </Radio.Group>
  );
}
