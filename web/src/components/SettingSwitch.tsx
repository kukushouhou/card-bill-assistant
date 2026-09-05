import { forwardRef, type ComponentRef } from 'react';
import { Switch, type SwitchProps } from 'antd';
import './setting-switch.css';

/** 保留表单、键盘和禁用行为；状态文字由所在设置行展示。 */
export default forwardRef<ComponentRef<typeof Switch>, Omit<SwitchProps, 'checkedChildren' | 'unCheckedChildren'>>(function SettingSwitch({ className, ...props }, ref) {
  return <Switch {...props} ref={ref} className={['setting-switch', className].filter(Boolean).join(' ')} data-skin-slot="switch" />;
});
