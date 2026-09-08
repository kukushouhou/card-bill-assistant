import { useRef, useState } from 'react';
import { Alert, App, Button, Col, Form, Input, Row, Select, Space } from 'antd';
import type { NotificationProviderDefinition } from '../api/types';
import { api } from '../api/client';
import { useDraftGuard } from '../lib/draftGuard';
import { useResponsive } from '../responsive';
import BusinessFlow from './BusinessFlow';
import { InlineConfirm } from './MobilePrimitives';
import { defaultNotificationConfig, NotificationConfigFields, type NotificationConfigValue } from './NotificationConfigFields';
import './notification-channels.css';

export interface NotificationDraft {
  type: string; name: string; config: NotificationConfigValue; enabled: boolean;
}

/** 渠道基本字段；类型切换只用于新建实例。 */
export function NotificationEditorFields({ providers, fixedType = false }: {
  providers: NotificationProviderDefinition[]; fixedType?: boolean;
}) {
  const form = Form.useFormInstance<NotificationDraft>();
  const type = Form.useWatch('type', form);
  const level = Form.useWatch(['config', 'level'], form);
  const provider = providers.find(item => item.type === type);
  return <>
    <section className="presentation-form-section notification-basic-fields">
      <h3>基本配置</h3>
      <Row gutter={20}>
        <Col xs={24} lg={12}><Form.Item name="type" label="渠道类型" rules={[{ required: true, message: '请选择渠道类型' }]}>
          <Select disabled={fixedType} placeholder="选择渠道类型" options={providers.map(item => ({ value: item.type, label: item.name }))}
            onChange={next => {
              const selected = providers.find(item => item.type === next)!;
              const name = form.getFieldValue('name');
              if (!name || providers.some(item => item.name === name)) form.setFieldValue('name', selected.name);
              form.setFieldValue('config', defaultNotificationConfig(selected));
            }} />
        </Form.Item></Col>
        <Col xs={24} lg={12}><Form.Item name="name" label="渠道名称" rules={[{ required: true, whitespace: true, message: '请输入渠道名称' }, { max: 100 }]}>
          <Input placeholder="例如：我的 iPhone" maxLength={100} />
        </Form.Item></Col>
      </Row>
    </section>
    {provider && <section className="notification-provider-fields" key={provider.type}>
      <NotificationConfigFields provider={provider} prefix={['config']} />
      {type === 'bark' && level === 'critical' && <div className="notification-field-note">重要警报会在静音模式下响铃，需要目标手机允许 Bark 发送重要警报。</div>}
      {type === 'bark' && level === 'timeSensitive' && <div className="notification-field-note">专注模式需允许 Bark 发送时效性通知。</div>}
    </section>}
  </>;
}

export default function NotificationChannelEditor({ providers, initial, onSave, onClose }: {
  providers: NotificationProviderDefinition[];
  initial?: NotificationDraft & { id?: number; configError?: string };
  onSave: (values: NotificationDraft) => Promise<void>; onClose: () => void;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [form] = Form.useForm<NotificationDraft>();
  const baseline = useRef<NotificationDraft>(initial ?? { type: '', name: '', enabled: true, config: {} });
  const [draft, setDraft] = useState(baseline.current);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const lock = useRef(false);
  useDraftGuard(dirty);
  const close = () => { if (lock.current) return; if (dirty) setLeaving(true); else onClose(); };
  const submit = async (testing: boolean) => {
    if (lock.current) return;
    lock.current = true;
    try {
      await form.validateFields();
      // 折叠字段和跨断点未挂载的字段仍属于该实例草稿。
      const values = { ...draft, ...form.getFieldsValue(true) };
      setDraft(values);
      setBusy(testing ? 'test' : 'save');
      if (testing) {
        await api.post('/api/settings/notification-channels/test', { type: values.type, name: values.name, config: values.config });
        message.success('测试通知已发送');
      } else {
        await onSave(values);
        setDirty(false);
        onClose();
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) message.error(error instanceof Error ? error.message : '操作失败，请重试');
    } finally { lock.current = false; setBusy(null); }
  };
  const buttons = <>
    <Button aria-label="测试" onClick={() => void submit(true)} loading={busy === 'test'} disabled={busy === 'save'}>测试</Button>
    <Button aria-label="保存" type="primary" onClick={() => void submit(false)} loading={busy === 'save'} disabled={busy === 'test'}>保存</Button>
    <Button onClick={close} disabled={busy !== null}>取消</Button>
  </>;
  return <BusinessFlow title={initial ? '编辑通知渠道' : '添加通知渠道'} width={1000} onClose={close}
    footer={leaving ? null : isMobile ? <div className="notification-editor-actions">{buttons}</div> : <Space>{buttons}</Space>}>
    {leaving && <InlineConfirm title="放弃未保存的修改？" description="退出后本次修改不会保存。" confirmText="放弃修改" danger={false} onCancel={() => setLeaving(false)} onConfirm={onClose} />}
    {initial?.configError && <Alert type="error" title={initial.configError} />}
    <Form form={form} name={'notification-' + (initial?.id ?? 'new')} layout="vertical" initialValues={draft} disabled={busy !== null}
      onValuesChange={() => { setDraft(form.getFieldsValue(true)); setDirty(true); }}>
      <NotificationEditorFields providers={providers} fixedType={Boolean(initial)} />
    </Form>
  </BusinessFlow>;
}
