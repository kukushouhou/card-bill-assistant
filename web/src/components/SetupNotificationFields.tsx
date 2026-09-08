import { Button, Col, Collapse, Dropdown, Empty, Form, Input, Row } from 'antd';
import type { NotificationProviderDefinition } from '../api/types';
import { DeleteOutlined, PlusOutlined } from '../skins/icons';
import { defaultNotificationConfig, NotificationConfigFields } from './NotificationConfigFields';
import type { NotificationDraft } from './NotificationChannelEditor';
import './notification-channels.css';

export default function SetupNotificationFields({ providers }: { providers: NotificationProviderDefinition[] }) {
  const form = Form.useFormInstance();
  // type 等固定元数据没有输入控件，监听时必须一并保留，避免字段挂载后类型消失。
  const entries: NotificationDraft[] = Form.useWatch('notificationEntries', { form, preserve: true }) ?? [];
  return <Form.List name="notificationEntries">{(fields, { add, remove }) => <>
    <div className="setup-actions">
      <Dropdown trigger={['click']} menu={{
        items: providers.map(provider => ({ key: provider.type, label: provider.name })),
        onClick: ({ key }) => {
          const provider = providers.find(item => item.type === key)!;
          const count = entries.filter(item => item.type === key).length;
          add({ type: key, name: provider.name + (count ? ' ' + (count + 1) : ''), enabled: true, config: defaultNotificationConfig(provider) });
        },
      }}><Button aria-label="添加渠道" icon={<PlusOutlined />} disabled={fields.length >= 20}>添加渠道</Button></Dropdown>
    </div>
    {fields.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="可稍后在系统设置中添加" />}
    {fields.map(field => {
      const entry = entries[field.name] ?? form.getFieldValue(['notificationEntries', field.name]);
      const provider = providers.find(item => item.type === entry?.type);
      if (!provider) return null;
      return <Collapse className="setup-notification-entry" key={field.key} defaultActiveKey={['entry']} items={[{
        key: 'entry', label: entry?.name || provider.name, forceRender: true,
        extra: <Button type="text" danger aria-label={'移除渠道 ' + (field.name + 1)} icon={<DeleteOutlined />}
          onClick={event => { event.stopPropagation(); remove(field.name); }} />,
        children: <>
          <Row gutter={20}>
            <Col xs={24} lg={12}><Form.Item label="渠道类型"><Input value={provider.name} readOnly /></Form.Item></Col>
            <Col xs={24} lg={12}><Form.Item name={[field.name, 'name']} label="渠道名称" rules={[{ required: true, whitespace: true, message: '请输入渠道名称' }]}>
              <Input maxLength={100} placeholder="例如：我的 iPhone" />
            </Form.Item></Col>
          </Row>
          <NotificationConfigFields provider={provider} prefix={[field.name, 'config']} />
        </>,
      }]} />;
    })}
  </>}</Form.List>;
}
