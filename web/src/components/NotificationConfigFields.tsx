import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Col, Collapse, Form, Input, Row, Select, Space, Typography } from 'antd';
import type { NotificationProviderDefinition } from '../api/types';

type PathPart = string | number;

export type NotificationConfigValue = Record<string, unknown>;

function path(prefix: PathPart[], key: string): PathPart[] {
  return [...prefix, key];
}

export function defaultNotificationConfig(provider: NotificationProviderDefinition): NotificationConfigValue {
  if (provider.configMode === 'custom-http') {
    return {
      method: 'POST',
      url: '',
      parameters: [
        { key: 'title', value: '{{title}}' },
        { key: 'body', value: '{{body}}' },
      ],
      queryParams: [],
      headers: [],
      bodyType: 'json',
      bodyTemplate: '',
    };
  }
  if (provider.type === 'ntfy') return { serverUrl: 'https://ntfy.sh' };
  if (provider.type === 'gotify') return { priority: '5' };
  return {};
}

function KeyValueEditor({
  name,
  label,
  keyPlaceholder,
  valuePlaceholder,
}: {
  name: PathPart[];
  label: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <Form.Item label={label} className="notification-pair-list">
      <Form.List name={name}>
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {fields.map((field) => (
              <div className="notification-pair-row" key={field.key}>
                <Form.Item
                  name={[field.name, 'key']}
                  rules={[{ required: true, message: '请输入名称' }]}
                  noStyle
                >
                  <Input placeholder={keyPlaceholder} />
                </Form.Item>
                <Form.Item name={[field.name, 'value']} noStyle>
                  <Input placeholder={valuePlaceholder} />
                </Form.Item>
                <Button
                  type="text"
                  danger
                  aria-label={`删除${label}`}
                  icon={<MinusCircleOutlined />}
                  onClick={() => remove(field.name)}
                />
              </div>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })}>
              添加{label}
            </Button>
          </Space>
        )}
      </Form.List>
    </Form.Item>
  );
}

function CustomHttpFields({ prefix }: { prefix: PathPart[] }) {
  return (
    <>
      <Row gutter={16}>
        <Col xs={24} lg={7}>
          <Form.Item name={path(prefix, 'method')} label="请求方法" rules={[{ required: true }]}>
            <Select options={['GET', 'POST', 'PUT', 'PATCH'].map((value) => ({ value, label: value }))} />
          </Form.Item>
        </Col>
        <Col xs={24} lg={17}>
          <Form.Item
            name={path(prefix, 'url')}
            label="请求 URL"
            rules={[
              { required: true, message: '请输入请求 URL' },
              {
                validator: async (_rule, value: unknown) => {
                  if (!value) return;
                  try {
                    const rendered = String(value).replace(/{{\s*[A-Za-z][A-Za-z0-9]*\s*}}/g, 'preview');
                    if (!['http:', 'https:'].includes(new URL(rendered).protocol)) throw new Error();
                  } catch {
                    throw new Error('请求 URL 格式不正确');
                  }
                },
              },
            ]}
          >
            <Input type="url" placeholder="https://example.com/webhook" />
          </Form.Item>
        </Col>
      </Row>

      <KeyValueEditor
        name={path(prefix, 'parameters')}
        label="基础参数"
        keyPlaceholder="参数名"
        valuePlaceholder="参数值，例如 {{title}}"
      />

      <Collapse
        ghost
        className="notification-advanced-collapse"
        items={[{
          key: 'advanced',
          label: '高级设置',
          children: (
            <>
              <Alert
                type="info"
                showIcon
                title="可用占位符"
                description="{{title}} 标题、{{body}} 正文、{{group}} 分组、{{count}} 数量、{{appName}} 应用名。GET 的基础参数放入查询串，其他方法默认组成请求正文。"
                style={{ marginBottom: 16 }}
              />
              <Row gutter={16}>
                <Col xs={24} lg={12}>
                  <KeyValueEditor
                    name={path(prefix, 'queryParams')}
                    label="查询参数"
                    keyPlaceholder="查询参数名"
                    valuePlaceholder="查询参数值"
                  />
                </Col>
                <Col xs={24} lg={12}>
                  <KeyValueEditor
                    name={path(prefix, 'headers')}
                    label="请求头"
                    keyPlaceholder="请求头名称"
                    valuePlaceholder="请求头值"
                  />
                </Col>
              </Row>
              <Form.Item name={path(prefix, 'bodyType')} label="正文类型">
                <Select
                  options={[
                    { value: 'json', label: 'JSON' },
                    { value: 'form', label: '表单' },
                    { value: 'text', label: '纯文本' },
                    { value: 'none', label: '无正文' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name={path(prefix, 'bodyTemplate')}
                label="正文模板"
                extra="留空时由基础参数自动生成正文；填写后使用模板内容。JSON 模板必须是有效 JSON，占位符写在字符串值中。"
              >
                <Input.TextArea
                  autoSize={{ minRows: 4, maxRows: 12 }}
                  placeholder={'例如：{\n  "title": "{{title}}",\n  "content": "{{body}}"\n}'}
                />
              </Form.Item>
            </>
          ),
        }]}
      />
    </>
  );
}

export function NotificationConfigFields({
  provider,
  prefix,
}: {
  provider: NotificationProviderDefinition;
  prefix: PathPart[];
}) {
  if (provider.configMode === 'custom-http') return <CustomHttpFields prefix={prefix} />;

  return (
    <Row gutter={16}>
      {provider.fields.map((field) => (
        <Col xs={24} lg={provider.fields.length > 1 ? 12 : 24} key={field.key}>
          <Form.Item
            name={path(prefix, field.key)}
            label={field.label}
            rules={[
              ...(field.required ? [{ required: true, message: `请输入${field.label}` }] : []),
              ...(field.type === 'url' ? [{ type: 'url' as const, message: `${field.label}格式不正确` }] : []),
            ]}
          >
            {field.type === 'password' ? (
              <Input.Password placeholder={field.placeholder} autoComplete="new-password" />
            ) : (
              <Input type={field.type === 'url' ? 'url' : 'text'} placeholder={field.placeholder} />
            )}
          </Form.Item>
        </Col>
      ))}
      {provider.fields.length === 0 && (
        <Col span={24}><Typography.Text type="secondary">此渠道没有额外配置项。</Typography.Text></Col>
      )}
    </Row>
  );
}
