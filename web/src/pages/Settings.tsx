import { useDraftGuard } from '../lib/draftGuard';
import SkinManager from '../skins/SkinManager';
import SettingSwitch from '../components/SettingSwitch';
import '../components/info-fields.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Card, Checkbox, Form, Input, Modal, Popover, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { BellOutlined, DeleteOutlined, InfoCircleOutlined, SafetyOutlined, SendOutlined } from '../skins/icons';
import { Popup } from 'antd-mobile';
import { api, ApiError } from '../api/client';
import type { MeInfo, SettingsInfo } from '../api/types';
import { Page } from '../components/Layout';
import {
  defaultNotificationConfig,
  NotificationConfigFields,
  type NotificationConfigValue,
} from '../components/NotificationConfigFields';
import { useResponsive, useResetOnModeChange } from '../responsive';
import {
  InlineConfirm,
  MobileFlow,
  MobilePullToRefresh,
  useCoalescedRefresh,
} from '../components/MobilePrimitives';
import './settings.css';

interface ReadFact<T> {
  value: T | null;
  loading: boolean;
  error: string | null;
}

interface WriteGuard {
  active: boolean;
  version: number;
}

type SharedRefresh = (options?: { freshAfterInFlight?: boolean }) => Promise<void>;

function PasswordCard() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  useDraftGuard(dirty);

  const submit = async (values: { oldPassword: string; newPassword: string; confirm: string }) => {
    if (loadingRef.current) return;
    if (values.newPassword !== values.confirm) {
      message.error('两次输入的新密码不一致');
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    try {
      await api.post('/api/auth/password', {
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });
      message.success('密码已修改');
      form.resetFields();
      setDirty(false);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '修改失败');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <Card className="settings-card" title="管理员密码" size="small" variant="outlined">
      <Form className="settings-form" form={form} layout="vertical" onValuesChange={() => setDirty(true)} onFinish={submit}>
        <Form.Item name="oldPassword" label="原密码" rules={[{ required: true }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item name="confirm" label="确认新密码" rules={[{ required: true }]}>
          <Input.Password />
        </Form.Item>
        <Space className="settings-form-actions settings-single-primary-action">
          <Button type="primary" htmlType="submit" loading={loading}>
            修改密码
          </Button>
        </Space>
      </Form>
    </Card>
  );
}

function usePinSettings({
  pin,
  beginWrite,
  endWrite,
  refreshPin,
}: {
  pin: MeInfo['pin'] | null;
  beginWrite: () => boolean;
  endWrite: () => void;
  refreshPin: SharedRefresh;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  useDraftGuard(dirty);
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [destroyStep, setDestroyStep] = useState(0);
  const [destroyPin, setDestroyPin] = useState('');
  const [destroyConfirmed, setDestroyConfirmed] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const loadingRef = useRef(false);
  const destroyingRef = useRef(false);

  const closeDestroy = useCallback(() => {
    setDestroyOpen(false);
    setDestroyStep(0);
    setDestroyPin('');
    setDestroyConfirmed(false);
  }, []);

  useResetOnModeChange(() => {
    form.resetFields(); setDirty(false);
    closeDestroy();
  });

  const setOrChange = async (values: { oldPin?: string; newPin: string }) => {
    if (!pin || loadingRef.current || !beginWrite()) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      if (pin.hasPin) {
        await api.put('/api/auth/pin', { oldPin: values.oldPin, newPin: values.newPin });
        message.success('PIN 已更换');
      } else {
        await api.post('/api/auth/pin', { pin: values.newPin });
        message.success('PIN 已设置');
      }
      form.resetFields(); setDirty(false);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      endWrite();
    }
    await refreshPin({ freshAfterInFlight: true }).catch(() => undefined);
    loadingRef.current = false;
    setLoading(false);
  };

  const destroy = async () => {
    if (!pin || !/^\d{6}$/.test(destroyPin) || !destroyConfirmed || destroyingRef.current || !beginWrite()) return;
    destroyingRef.current = true;
    setDestroying(true);
    try {
      const result = await api.delete<{ destroyedCards: number }>('/api/auth/pin', { pin: destroyPin });
      message.success(`PIN 已作废，清除了 ${result.destroyedCards} 张卡的敏感信息`);
      closeDestroy();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
      setDestroyPin('');
      setDestroyConfirmed(false);
      setDestroyStep(isMobile ? 1 : 0);
    } finally {
      endWrite();
    }
    await refreshPin({ freshAfterInFlight: true }).catch(() => undefined);
    destroyingRef.current = false;
    setDestroying(false);
  };

  const openDestroy = () => {
    if (destroyingRef.current) return;
    setDestroyOpen(true);
    setDestroyStep(0);
    setDestroyPin('');
    setDestroyConfirmed(false);
  };

  const requestCloseDestroy = () => {
    if (destroyingRef.current) return;
    closeDestroy();
  };

  return {
    isMobile,
    pin,
    form,
    loading,
    destroyOpen,
    destroyStep,
    destroyPin,
    destroyConfirmed,
    destroying,
    setDestroyStep,
    setDestroyPin,
    setDestroyConfirmed,
    onDraftChange: () => setDirty(true),
    setOrChange,
    destroy,
    openDestroy,
    requestCloseDestroy,
  };
}

type PinSettingsController = ReturnType<typeof usePinSettings>;

function PinCard({
  controller,
  reading,
  readError,
  onRetry,
}: {
  controller: PinSettingsController;
  reading: boolean;
  readError: string | null;
  onRetry: SharedRefresh;
}) {
  const {
    isMobile,
    pin,
    form,
    loading: writing,
    destroyOpen,
    destroyPin,
    destroyConfirmed,
    destroying,
    setDestroyPin,
    setDestroyConfirmed,
    setOrChange,
    destroy,
    openDestroy,
    requestCloseDestroy,
  } = controller;
  const [securityOpen, setSecurityOpen] = useState(false);

  useResetOnModeChange(() => setSecurityOpen(false));

  const securityTrigger = (
    <button
      type="button"
      className="settings-security-trigger"
      aria-label="查看 PIN 安全说明"
      onClick={isMobile ? () => setSecurityOpen(true) : undefined}
    >
      <InfoCircleOutlined />
    </button>
  );

  const securityContent = (
    <div className="settings-security-content">
      <Typography.Title level={5}>PIN 如何保护卡信息</Typography.Title>
      <Typography.Paragraph>
        查看完整卡号、有效期和 CVV 时需要输入 PIN。
      </Typography.Paragraph>
      <ul>
        <li>PIN 不会保存在服务器、数据库或日志中。</li>
        <li>连续 5 次输错会锁定 15 分钟。</li>
        <li>忘记 PIN 只能作废；作废会永久删除卡片敏感信息。</li>
      </ul>
    </div>
  );

  return (
    <>
      <Card
        className="settings-card"
        title={
          <span className="settings-card-title">
            <SafetyOutlined />
            <span>卡信息加密 PIN</span>
          {pin ? (
            pin.hasPin
                ? <Tag color="green">已设置</Tag>
                : <Tag color="orange">未设置</Tag>
          ) : (
              <Tag>状态未知</Tag>
          )}
          {pin?.locked && <Tag color="red">已锁定</Tag>}
            {isMobile ? securityTrigger : (
              <Popover trigger="click" placement="bottomRight" content={securityContent}>
                {securityTrigger}
              </Popover>
            )}
          </span>
        }
        size="small"
        variant="outlined"
      >
      {readError && (
        <Alert
          type="error"
          showIcon
          title="PIN 状态读取失败"
          description={pin ? `${readError}。当前保留上次成功读取的状态，请重试确认。` : `${readError}。状态确认前不能修改 PIN。`}
          action={
            <Button size="small" loading={reading} onClick={() => void onRetry().catch(() => undefined)}>
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      <Form className="settings-form" form={form} layout="vertical" disabled={Boolean(readError)} onValuesChange={controller.onDraftChange} onFinish={setOrChange}>
        {!pin ? (
          !readError && (
            <div className="mobile-section-loading">
              <Spin description="正在读取 PIN 状态"><div style={{ width: 180, height: 52 }} /></Spin>
            </div>
          )
        ) : (
          <>
            {pin.hasPin && (
              <Form.Item name="oldPin" label="当前 PIN" rules={[{ required: true, pattern: /^\d{6}$/, message: '6 位数字' }]}>
                <Input.Password maxLength={6} />
              </Form.Item>
            )}
            <Form.Item name="newPin" label={pin.hasPin ? '新 PIN' : '设置 PIN'} rules={[{ required: true, pattern: /^\d{6}$/, message: '6 位数字' }]}>
              <Input.Password maxLength={6} placeholder="6 位数字" />
            </Form.Item>
            <Space
              wrap
              className={`settings-form-actions ${pin.hasPin ? 'settings-paired-actions' : 'settings-single-primary-action'}`}
            >
              {pin.hasPin && isMobile && (
                <Button danger onClick={openDestroy} disabled={writing || destroying}>
                  忘记 PIN，作废卡信息
                </Button>
              )}
              <Button type="primary" htmlType="submit" loading={writing} disabled={destroying}>
                {pin.hasPin ? '更换 PIN' : '设置 PIN'}
              </Button>
              {pin.hasPin && !isMobile && (
                <Button danger onClick={openDestroy} disabled={writing || destroying}>
                  忘记 PIN，作废卡信息
                </Button>
              )}
            </Space>
          </>
        )}
      </Form>
      {!isMobile && (
        <Modal
          title="作废卡信息加密 PIN"
          open={destroyOpen}
          onCancel={requestCloseDestroy}
          mask={{ closable: false }}
          closable={!destroying}
          keyboard={!destroying}
          footer={
            <Space>
              <Button onClick={requestCloseDestroy} disabled={destroying}>取消</Button>
              <Button
                danger
                type="primary"
                loading={destroying}
                disabled={!/^\d{6}$/.test(destroyPin) || !destroyConfirmed}
                onClick={() => void destroy()}
              >
                作废 PIN 并删除敏感信息
              </Button>
            </Space>
          }
        >
          <Alert
            type="error"
            showIcon
            title="此操作不可恢复"
            description="作废后将永久删除所有卡片的完整卡号、有效期和 CVV；非敏感卡片档案与账单不受影响。"
          />
          <Form layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item label="当前 6 位 PIN" required>
              <Input.Password
                value={destroyPin}
                onChange={(event) => setDestroyPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
              />
            </Form.Item>
            <Checkbox checked={destroyConfirmed} onChange={(event) => setDestroyConfirmed(event.target.checked)}>
              我确认永久删除全部卡片敏感信息
            </Checkbox>
          </Form>
        </Modal>
      )}
      </Card>
      {isMobile && (
        <Popup
          visible={securityOpen}
          position="bottom"
          onMaskClick={() => setSecurityOpen(false)}
          onClose={() => setSecurityOpen(false)}
          bodyStyle={{ borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '72vh', overflowY: 'auto' }}
        >
          <div className="settings-security-sheet">
            <div className="settings-security-sheet-handle" aria-hidden="true" />
            {securityContent}
            <div className="settings-single-primary-action settings-security-sheet-action">
              <Button type="primary" onClick={() => setSecurityOpen(false)}>知道了</Button>
            </div>
          </div>
        </Popup>
      )}
    </>
  );
}

function MobilePinDestroyFlow({ controller }: { controller: PinSettingsController }) {
  const {
    destroyStep,
    destroyPin,
    destroying,
    setDestroyStep,
    setDestroyPin,
    setDestroyConfirmed,
    destroy,
    requestCloseDestroy,
  } = controller;

  return (
    <MobileFlow title="作废 PIN" onBack={requestCloseDestroy}>
      {destroyStep === 0 && (
        <Card>
          <Alert
            type="error"
            showIcon
            title="此操作不可恢复"
            description="作废后将永久删除所有卡片的完整卡号、有效期和 CVV；非敏感卡片档案与账单不受影响。"
          />
          <div className="settings-mobile-confirm-actions">
            <Button onClick={requestCloseDestroy}>取消</Button>
            <Button type="primary" danger onClick={() => setDestroyStep(1)}>
              继续验证当前 PIN
            </Button>
          </div>
        </Card>
      )}
      {destroyStep === 1 && (
        <Card title="输入当前 6 位 PIN">
          <Input.Password
            autoFocus
            value={destroyPin}
            onChange={(event) => setDestroyPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            maxLength={6}
            placeholder="6 位数字"
          />
          <div className="settings-mobile-confirm-actions">
            <Button onClick={requestCloseDestroy}>取消</Button>
            <Button
              type="primary"
              danger
              disabled={!/^\d{6}$/.test(destroyPin)}
              onClick={() => {
                setDestroyConfirmed(true);
                setDestroyStep(2);
              }}
            >
              继续最终确认
            </Button>
          </div>
        </Card>
      )}
      {destroyStep === 2 && (
        <InlineConfirm
          title="永久作废 PIN 并删除敏感信息？"
          description="最终确认后，将立即删除所有卡片的完整卡号、有效期和 CVV，且无法恢复。"
          confirmText="确认作废并删除"
          loading={destroying}
          onCancel={() => {
            setDestroyPin('');
            setDestroyConfirmed(false);
            setDestroyStep(1);
          }}
          onConfirm={() => void destroy()}
        />
      )}
    </MobileFlow>
  );
}

interface NotificationFormValues {
  enabled: boolean;
  config: NotificationConfigValue;
}

function NotificationChannelsCard({
  settings,
  reading,
  readError,
  onRetry,
  beginWrite,
  endWrite,
  refreshSettings,
}: {
  settings: SettingsInfo | null;
  reading: boolean;
  readError: string | null;
  onRetry: SharedRefresh;
  beginWrite: () => boolean;
  endWrite: () => void;
  refreshSettings: SharedRefresh;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [form] = Form.useForm<NotificationFormValues>();
  const sendingEnabled = Form.useWatch('enabled', form);
  const [selectedType, setSelectedType] = useState('bark');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmRemoving, setConfirmRemoving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const initialized = useRef(false);
  useDraftGuard(dirty);
  const loadingRef = useRef(false);
  const testingRef = useRef(false);

  const notificationSettings = settings?.notifications ?? { providers: [], channels: [] };
  const providers = notificationSettings.providers;
  const selectedProvider = providers.find((provider) => provider.type === selectedType) ?? providers[0];
  const selectedChannel = notificationSettings.channels.find((channel) => channel.type === selectedProvider?.type);

  useEffect(() => {
    if (settings && !form.isFieldsTouched()) {
      const available = settings.notifications;
      const nextType = initialized.current ? selectedType : available.channels[0]?.type ?? available.providers[0]?.type ?? 'bark';
      initialized.current = true;
      const nextChannel = available.channels.find((channel) => channel.type === nextType);
      setSelectedType(nextType);
      const provider = available.providers.find((item) => item.type === nextType) ?? available.providers[0];
      form.setFieldsValue({
        enabled: nextChannel?.enabled ?? true,
        config: { ...(provider ? defaultNotificationConfig(provider) : {}), ...(nextChannel?.config ?? {}) },
      });
    }
  }, [form, settings, selectedType]); // notificationSettings 由 settings 派生，不单独作为依赖避免重置正在编辑的表单。

  const commitProvider = (type: string) => {
    setDirty(false); setPendingProvider(null); form.resetFields();
    const channel = notificationSettings.channels.find((item) => item.type === type);
    setSelectedType(type);
    setConfirmRemoving(false);
    form.setFieldsValue({
      enabled: channel?.enabled ?? true,
      config: { ...defaultNotificationConfig(providers.find((item) => item.type === type)!), ...(channel?.config ?? {}) },
    });
  };

  const selectProvider = (type: string) => {
    if (type === selectedType || loadingRef.current || testingRef.current) return;
    if (dirty) setPendingProvider(type); else commitProvider(type);
  };

  const save = async (values: NotificationFormValues) => {
    if (!selectedProvider) return;
    if (loadingRef.current || !beginWrite()) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await api.put(`/api/settings/notification-channels/${encodeURIComponent(selectedProvider.type)}`, values);
      message.success('通知渠道已保存');
      setDirty(false);
      form.resetFields();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '通知渠道保存失败');
    } finally {
      endWrite();
    }
    await refreshSettings({ freshAfterInFlight: true }).catch(() => undefined);
    loadingRef.current = false;
    setLoading(false);
  };

  const test = async () => {
    if (!selectedProvider || testingRef.current) return;
    let values: NotificationFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    testingRef.current = true;
    setTesting(true);
    try {
      await api.post(`/api/settings/notification-channels/${encodeURIComponent(selectedProvider.type)}/test`, {
        config: values.config,
      });
      message.success('测试通知已发送');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '测试通知发送失败');
    } finally {
      testingRef.current = false;
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!selectedProvider || loadingRef.current || !beginWrite()) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await api.delete(`/api/settings/notification-channels/${encodeURIComponent(selectedProvider.type)}`);
      message.success('通知渠道已停用并移除');
      setConfirmRemoving(false);
      form.resetFields();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '通知渠道移除失败');
    } finally {
      endWrite();
    }
    await refreshSettings({ freshAfterInFlight: true }).catch(() => undefined);
    loadingRef.current = false;
    setLoading(false);
  };

  return (
    <Card
      className="settings-card"
      title={<span className="settings-card-title"><BellOutlined /><span>通知渠道</span></span>}
      size="small"
      variant="outlined"
      extra={selectedChannel ? <Tag color={selectedChannel.enabled ? 'success' : 'default'}>{selectedChannel.enabled ? '已启用' : '已停用'}</Tag> : <Tag>未配置</Tag>}
    >
      <Typography.Paragraph className="settings-notification-description" type="secondary">
        还款、出账、年费和自定义提醒会通过已启用的渠道发送。同一渠道的当日提醒会合并，避免连续打扰。
      </Typography.Paragraph>
      {notificationSettings.channels.length > 0 && (
        <Space wrap className="settings-notification-channel-summary">
          <Typography.Text type="secondary">已配置：</Typography.Text>
          {notificationSettings.channels.map((channel) => (
            <Tag key={channel.type} color={channel.enabled ? 'success' : 'default'}>
              {channel.name}{channel.enabled ? '' : '（已停用）'}
            </Tag>
          ))}
        </Space>
      )}
      {readError && (
        <Alert
          type="error"
          showIcon
          title="通知渠道读取失败"
          description={settings ? `${readError}。当前保留上次成功读取的设置，请重试确认。` : `${readError}。设置确认前不能保存或测试。`}
          action={
            <Button size="small" loading={reading} onClick={() => void onRetry().catch(() => undefined)}>
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      {!settings ? (
        !readError && (
          <div className="mobile-section-loading">
            <Spin description="正在读取通知渠道"><div style={{ width: 180, height: 52 }} /></Spin>
          </div>
        )
      ) : (
        <Form
          className="settings-form settings-notification-form"
          form={form}
          layout="vertical"
          disabled={Boolean(readError)}
          initialValues={{ enabled: true, config: {} }}
          onValuesChange={() => setDirty(true)}
          onFinish={save}
        >
          {pendingProvider && <InlineConfirm title="切换通知渠道？" description="当前渠道有未保存的修改。" confirmText="放弃修改并切换" onCancel={() => setPendingProvider(null)} onConfirm={() => commitProvider(pendingProvider)} />}
          <section className="presentation-form-section settings-channel-section">
          <h3>发送渠道</h3>
          <Form.Item label="渠道类型">
            {isMobile ? (
              <Radio.Group
                className="settings-provider-options"
                value={selectedProvider?.type}
                options={providers.map((provider) => ({ value: provider.type, label: provider.name }))}
                optionType="button"
                buttonStyle="solid"
                onChange={(event) => selectProvider(event.target.value)}
              />
            ) : (
              <Select
                value={selectedProvider?.type}
                options={providers.map((provider) => ({ value: provider.type, label: provider.name }))}
                onChange={selectProvider}
                placeholder="选择通知渠道"
              />
            )}
          </Form.Item>
          {selectedProvider && (
            <Alert
              type="info"
              showIcon
              title={selectedProvider.name}
              description={selectedProvider.description}
              style={{ marginBottom: 16 }}
            />
          )}
          <div className="settings-delivery-row">
            <div className="settings-delivery-copy"><strong>发送状态</strong><span>{sendingEnabled === false ? '关闭' : '开启'}</span></div>
            <Form.Item name="enabled" valuePropName="checked" noStyle><SettingSwitch aria-label="发送状态" /></Form.Item>
          </div>
          </section>
          <section className="presentation-form-section settings-connection-section">
            <h3>连接配置</h3>
            {selectedProvider && <NotificationConfigFields provider={selectedProvider} prefix={['config']} />}
          </section>
          {confirmRemoving && (
            isMobile ? (
              <div className="settings-notification-remove-confirm">
                <Alert
                  type="warning"
                  showIcon
                  title={`停用并移除 ${selectedProvider?.name ?? '此渠道'}？`}
                  description="移除后不会再通过此渠道发送提醒，可以随时重新绑定。"
                />
                <div className="settings-mobile-confirm-actions">
                  <Button onClick={() => setConfirmRemoving(false)}>取消</Button>
                  <Button type="primary" danger loading={loading} onClick={() => void remove()}>确认移除</Button>
                </div>
              </div>
            ) : (
              <Alert
                type="warning"
                showIcon
                title={`停用并移除 ${selectedProvider?.name ?? '此渠道'}？`}
                description="移除后不会再通过此渠道发送提醒，可以随时重新绑定。"
                action={(
                  <Space wrap>
                    <Button size="small" onClick={() => setConfirmRemoving(false)}>取消</Button>
                    <Button size="small" danger loading={loading} onClick={() => void remove()}>确认移除</Button>
                  </Space>
                )}
                style={{ marginBottom: 16 }}
              />
            )
          )}
          {isMobile ? (
            <div className="settings-notification-actions">
              <Button icon={<SendOutlined />} onClick={test} loading={testing} disabled={loading}>
                发送测试通知
              </Button>
              {selectedChannel && !confirmRemoving && (
                <Button danger icon={<DeleteOutlined />} onClick={() => setConfirmRemoving(true)} disabled={loading || testing}>
                  停用并移除
                </Button>
              )}
              <Button
                className="settings-notification-primary-action"
                type="primary"
                htmlType="submit"
                loading={loading}
                disabled={testing}
              >
                保存
              </Button>
            </div>
          ) : (
            <Space wrap className="settings-notification-actions">
              <Button type="primary" htmlType="submit" loading={loading} disabled={testing}>
                保存
              </Button>
              <Button icon={<SendOutlined />} onClick={test} loading={testing} disabled={loading}>
                发送测试通知
              </Button>
              {selectedChannel && !confirmRemoving && (
                <Button danger icon={<DeleteOutlined />} onClick={() => setConfirmRemoving(true)} disabled={loading || testing}>
                  停用并移除
                </Button>
              )}
            </Space>
          )}
        </Form>
      )}
    </Card>
  );
}

export default function Settings() {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [pinFact, setPinFact] = useState<ReadFact<MeInfo['pin']>>({
    value: null,
    loading: false,
    error: null,
  });
  const [settingsFact, setSettingsFact] = useState<ReadFact<SettingsInfo>>({
    value: null,
    loading: false,
    error: null,
  });
  const pinWriteGuard = useRef<WriteGuard>({ active: false, version: 0 });
  const notificationWriteGuard = useRef<WriteGuard>({ active: false, version: 0 });

  const beginPinWrite = useCallback(() => {
    if (pinWriteGuard.current.active) return false;
    pinWriteGuard.current.active = true;
    pinWriteGuard.current.version += 1;
    return true;
  }, []);
  const endPinWrite = useCallback(() => {
    pinWriteGuard.current.active = false;
  }, []);
  const beginNotificationWrite = useCallback(() => {
    if (notificationWriteGuard.current.active) return false;
    notificationWriteGuard.current.active = true;
    notificationWriteGuard.current.version += 1;
    return true;
  }, []);
  const endNotificationWrite = useCallback(() => {
    notificationWriteGuard.current.active = false;
  }, []);

  const loadPin = useCallback(async () => {
    const version = pinWriteGuard.current.version;
    if (pinWriteGuard.current.active) return;
    setPinFact((current) => ({ ...current, loading: true }));
    try {
      const me = await api.get<MeInfo>('/api/auth/me');
      if (pinWriteGuard.current.active || pinWriteGuard.current.version !== version) return;
      setPinFact({ value: me.pin, loading: false, error: null });
    } catch (error) {
      if (pinWriteGuard.current.active || pinWriteGuard.current.version !== version) return;
      setPinFact((current) => ({
        ...current,
        loading: false,
        error: error instanceof ApiError ? error.message : '无法读取 PIN 状态',
      }));
      throw error;
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const version = notificationWriteGuard.current.version;
    if (notificationWriteGuard.current.active) return;
    setSettingsFact((current) => ({ ...current, loading: true }));
    try {
      const settings = await api.get<SettingsInfo>('/api/settings');
      if (notificationWriteGuard.current.active || notificationWriteGuard.current.version !== version) return;
      setSettingsFact({ value: settings, loading: false, error: null });
    } catch (error) {
      if (notificationWriteGuard.current.active || notificationWriteGuard.current.version !== version) return;
      setSettingsFact((current) => ({
        ...current,
        loading: false,
        error: error instanceof ApiError ? error.message : '无法读取通知渠道',
      }));
      throw error;
    }
  }, []);

  const refreshPin = useCoalescedRefresh(loadPin);
  const refreshSettings = useCoalescedRefresh(loadSettings);

  useEffect(() => {
    void refreshPin().catch(() => undefined);
    void refreshSettings().catch(() => undefined);
  }, [refreshPin, refreshSettings]);

  const pinController = usePinSettings({
    pin: pinFact.value,
    beginWrite: beginPinWrite,
    endWrite: endPinWrite,
    refreshPin,
  });

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([refreshPin(), refreshSettings()]);
    if (results.some((result) => result.status === 'rejected')) {
      message.warning('部分设置刷新失败，请在对应设置项重试');
      throw new Error('部分设置刷新失败');
    }
  }, [message, refreshPin, refreshSettings]);

  const mobileDestroyActive = isMobile && pinController.destroyOpen;

  return (
    <>
      <div
        aria-hidden={mobileDestroyActive || undefined}
        inert={mobileDestroyActive || undefined}
        style={mobileDestroyActive ? { display: 'none' } : undefined}
      >
        <Page title="系统设置">
          <MobilePullToRefresh onRefresh={refresh}>
            <div className="settings-grid">
              <div className="settings-grid-skins"><SkinManager /></div>
              <div className="settings-grid-password">
                <PasswordCard />
              </div>
              <div className="settings-grid-pin">
                <PinCard
                  controller={pinController}
                  reading={pinFact.loading}
                  readError={pinFact.error}
                  onRetry={refreshPin}
                />
              </div>
              <div className="settings-grid-notifications">
                <NotificationChannelsCard
                  settings={settingsFact.value}
                  reading={settingsFact.loading}
                  readError={settingsFact.error}
                  onRetry={refreshSettings}
                  beginWrite={beginNotificationWrite}
                  endWrite={endNotificationWrite}
                  refreshSettings={refreshSettings}
                />
              </div>
            </div>
          </MobilePullToRefresh>
        </Page>
      </div>
      {mobileDestroyActive && <MobilePinDestroyFlow controller={pinController} />}
    </>
  );
}
