import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Col, Collapse, Divider, Form, Input, Row, Steps, Tag, Typography } from 'antd';
import { ApiOutlined, BellOutlined, CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import { useAppName } from '../appName';
import type { SetupStatus } from '../api/types';
import { useResponsive } from '../responsive';
import {
  defaultNotificationConfig,
  NotificationConfigFields,
  type NotificationConfigValue,
} from '../components/NotificationConfigFields';

/**
 * 安装向导（全屏独立页，不进 Layout）：
 * ① 环境检查 → ② 管理员账户与可选 PIN → ③ 通知渠道 → ④ 完成
 */
export default function Setup({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp();
  const appName = useAppName();
  const { isMobile } = useResponsive();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notificationTypes, setNotificationTypes] = useState<string[]>([]);
  const [expandedNotificationType, setExpandedNotificationType] = useState<string>();
  const [form] = Form.useForm();
  const checkingRef = useRef(false);
  const installingRef = useRef(false);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const s = await api.get<SetupStatus>('/api/setup/status');
      setStatus(s);
      if (s.installed) setStep(3); // 其它浏览器已完成安装，直接进入完成页
    } catch (err) {
      setStatus(null);
      message.error(err instanceof ApiError ? err.message : '无法连接服务器，请确认服务已启动');
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [message]);

  useEffect(() => {
    void check();
  }, [check]);

  const onInstall = async (values: {
    password: string;
    pin?: string;
    notificationConfigs?: Record<string, NotificationConfigValue>;
  }) => {
    if (installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    try {
      await api.post('/api/setup/install', {
        password: values.password,
        pin: values.pin || undefined,
        notifications: notificationTypes.map((type) => ({
          type,
          config: values.notificationConfigs?.[type] ?? {},
        })),
      });
      message.success('安装完成');
      form.resetFields();
      setStep(3);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        form.resetFields();
        setStep(3); // 已被并发安装
      } else {
        message.error(err instanceof ApiError ? err.message : '安装失败，请重试');
      }
    } finally {
      installingRef.current = false;
      setInstalling(false);
    }
  };

  const dbOk = status?.dbOk ?? false;
  const reachable = status !== null;

  return (
    <div
      className={`auth-screen setup-screen ${isMobile ? 'auth-screen-mobile' : 'auth-screen-desktop'}`}
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card className="auth-card setup-card" title={`${appName} · 安装向导`}>
        <Steps
          size="small"
          current={step}
          responsive
          items={[{ title: '环境检查' }, { title: '账户设置' }, { title: '通知渠道' }, { title: '完成' }]}
          style={{ marginBottom: 24 }}
        />

        {step === 0 && (
          <>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ApiOutlined />
              <span>数据库连接：</span>
              {checking ? (
                <Tag color="processing">检测中…</Tag>
              ) : reachable ? (
                dbOk ? (
                  <Tag color="success" icon={<CheckCircleOutlined />}>
                    正常
                  </Tag>
                ) : (
                  <Tag color="error">不可用</Tag>
                )
              ) : (
                <Tag color="error">服务器无响应</Tag>
              )}
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void check()} loading={checking}>
                重新检测
              </Button>
            </div>
            {reachable && !dbOk && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                title="数据库连接失败"
                description="请检查数据库配置与网络连通性，恢复后点击「重新检测」。"
              />
            )}
            <Button type="primary" block disabled={!dbOk} onClick={() => setStep(1)}>
              下一步
            </Button>
          </>
        )}

        {step === 1 && (
          <Form form={form} layout="vertical" autoFocus>
            <Row gutter={32}>
              <Col xs={24} md={12}>
                <Form.Item label="管理员账号">
                  <Input value="admin" readOnly variant="filled" />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="登录密码"
                  rules={[
                    { required: true, message: '请输入密码' },
                    { min: 8, message: '密码长度至少 8 位' },
                  ]}
                >
                  <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  name="confirm"
                  label="确认密码"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator: (_, value) =>
                        !value || getFieldValue('password') === value
                          ? Promise.resolve()
                          : Promise.reject(new Error('两次输入的密码不一致')),
                    }),
                  ]}
                >
                  <Input.Password placeholder="再次输入密码" autoComplete="new-password" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Divider plain style={{ margin: '0 0 16px' }}>
                  卡片信息加密（可选）
                </Divider>
                <Form.Item
                  name="pin"
                  label="PIN 码"
                  rules={[
                    {
                      validator: (_, value) =>
                        !value || /^\d{6}$/.test(value)
                          ? Promise.resolve()
                          : Promise.reject(new Error('PIN 必须为 6 位数字')),
                    },
                  ]}
                >
                  <Input.Password maxLength={6} placeholder="6 位数字" inputMode="numeric" />
                </Form.Item>
                <Form.Item
                  name="pinConfirm"
                  label="确认 PIN"
                  dependencies={['pin']}
                  rules={[
                    ({ getFieldValue }) => ({
                      validator: (_, value) =>
                        !value && !getFieldValue('pin')
                          ? Promise.resolve()
                          : !getFieldValue('pin')
                            ? Promise.reject(new Error('请先输入 PIN 码'))
                            : !value
                              ? Promise.reject(new Error('请再次输入 PIN'))
                              : value === getFieldValue('pin')
                                ? Promise.resolve()
                                : Promise.reject(new Error('两次输入的 PIN 不一致')),
                    }),
                  ]}
                >
                  <Input.Password maxLength={6} placeholder="再次输入 6 位数字" inputMode="numeric" />
                </Form.Item>
              </Col>
            </Row>

            <Alert
              type="success"
              showIcon
              title="卡片信息仅你可见"
              description={
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  设置 PIN 后，卡号、有效期、CVV 将以 PIN 双密钥加密保管，这把钥匙只在你手中。
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · PIN 不做任何留存——服务器、数据库、日志均无处可寻
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · 遗忘 PIN，任何人都无法找回你的数据
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · 重置 PIN 将清空已保存的全部卡片数据
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · PIN 设置可跳过，之后可在设置页补设；未设置时将无法保存卡号等信息
                  </Typography.Text>
                </Typography.Text>
              }
              style={{ marginTop: 8 }}
            />

            <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button
                type="primary"
                style={{ flex: 1 }}
                onClick={() => {
                  void form
                    .validateFields(['password', 'confirm', 'pin', 'pinConfirm'])
                    .then(() => setStep(2))
                    .catch(() => undefined);
                }}
              >
                下一步
              </Button>
            </div>
          </Form>
        )}

        {step === 2 && (
          <Form form={form} layout="vertical" onFinish={onInstall} initialValues={{ notificationConfigs: {} }}>
            <div className="setup-notification-heading" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <BellOutlined />
              <div>
                <Typography.Title level={5} style={{ margin: 0 }}>选择通知渠道</Typography.Title>
                <Typography.Text type="secondary">可选择多个渠道同时发送，也可暂不配置，安装后再到系统设置中添加。</Typography.Text>
              </div>
            </div>

            <Checkbox.Group
              className="setup-notification-options"
              value={notificationTypes}
              onChange={(values) => {
                const nextTypes = values.map(String);
                const added = nextTypes.find((type) => !notificationTypes.includes(type));
                if (added) {
                  const provider = (status?.notificationProviders ?? []).find((item) => item.type === added);
                  if (provider && form.getFieldValue(['notificationConfigs', added]) == null) {
                    form.setFieldValue(['notificationConfigs', added], defaultNotificationConfig(provider));
                  }
                  setExpandedNotificationType(added);
                }
                setNotificationTypes(nextTypes);
              }}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}
            >
              {(status?.notificationProviders ?? []).map((provider) => (
                <Checkbox key={provider.type} value={provider.type}>{provider.name}</Checkbox>
              ))}
            </Checkbox.Group>

            {notificationTypes.length === 0 ? (
              <Alert
                type="info"
                showIcon
                title="安装后不会发送系统通知"
                description="账单与提醒仍会正常生成，你可以稍后在设置页绑定通知渠道。"
                style={{ marginTop: 20 }}
              />
            ) : (
              <Collapse
                accordion
                className="setup-notification-config"
                style={{ marginTop: 20 }}
                activeKey={expandedNotificationType}
                onChange={(key) => setExpandedNotificationType(Array.isArray(key) ? key[0] : key)}
                items={(status?.notificationProviders ?? [])
                  .filter((provider) => notificationTypes.includes(provider.type))
                  .map((provider) => ({
                    key: provider.type,
                    label: provider.name,
                    children: (
                      <>
                        <Typography.Paragraph type="secondary">{provider.description}</Typography.Paragraph>
                        <NotificationConfigFields
                          provider={provider}
                          prefix={['notificationConfigs', provider.type]}
                        />
                      </>
                    ),
                  }))}
              />
            )}

            <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button type="primary" htmlType="submit" loading={installing} style={{ flex: 1 }}>
                完成安装
              </Button>
            </div>
          </Form>
        )}

        {step === 3 && (
          <>
            <Alert type="success" showIcon title="安装完成！" style={{ marginBottom: 24 }} />
            <Button type="primary" block size="large" onClick={onDone}>
              前往登录
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
