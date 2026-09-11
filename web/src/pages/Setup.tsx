import BuiltinSkinPicker from '../skins/BuiltinSkinPicker';
import { useSkin, SkinDecorations, ColorModeSwitch } from '../skins/SkinProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Col, Divider, Form, Input, Row, Steps, Tag, Typography } from 'antd';
import { ApiOutlined, BellOutlined, CheckCircleOutlined, ReloadOutlined } from '../skins/icons';
import { api, ApiError } from '../api/client';
import { useAppName } from '../appName';
import type { OverdueBasis, SetupStatus } from '../api/types';
import { useResponsive } from '../responsive';
import { useDraftGuard } from '../lib/draftGuard';
import SetupNotificationFields from '../components/SetupNotificationFields';
import OverdueBasisRadio from '../components/OverdueBasisRadio';
import type { NotificationDraft } from '../components/NotificationChannelEditor';

interface SetupAccountValues {
  password: string;
  pin?: string;
}

interface SetupNotificationValues {
  notificationEntries?: NotificationDraft[];
}

interface SetupFormValues extends SetupAccountValues, SetupNotificationValues {
  confirm: string;
  pinConfirm?: string;
}

const SETUP_STEPS = ['环境检查', '账户设置', '通知渠道', '外观主题', '完成'];
const COMPLETE_STEP = SETUP_STEPS.length - 1;

/**
 * 安装向导（全屏独立页，不进 Layout）：
 * 环境检查 → 账户设置 → 通知渠道 → 外观主题 → 完成
 */
export default function Setup({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp();
  const appName = useAppName();
  const { isMobile } = useResponsive();
  const [step, setStep] = useState(0);
  const [skinId, setSkinId] = useState('modern');
  const [overdueBasis, setOverdueBasis] = useState<OverdueBasis>('all');
  const appearance = useSkin();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  useDraftGuard(hasDraft && step < COMPLETE_STEP);
  const [form] = Form.useForm<SetupFormValues>();
  const checkingRef = useRef(false);
  const installingRef = useRef(false);
  const accountValuesRef = useRef<SetupAccountValues | null>(null);
  const notificationValuesRef = useRef<SetupNotificationValues>({});

  useEffect(() => {
    if (step === 2) form.setFieldValue('notificationEntries', structuredClone(notificationValuesRef.current.notificationEntries ?? []));
  }, [form, step]);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const s = await api.get<SetupStatus>('/api/setup/status');
      setStatus(s);
      if (s.installed) setStep(COMPLETE_STEP); // 其它浏览器已完成安装，直接进入完成页
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

  const onInstall = async () => {
    if (installingRef.current) return;
    const accountValues = accountValuesRef.current;
    if (!accountValues) {
      message.error('请重新设置管理员账户');
      setStep(1);
      return;
    }
    installingRef.current = true;
    setInstalling(true);
    const values = notificationValuesRef.current;
    try {
      await api.post('/api/setup/install', {
        skinId,
        password: accountValues.password,
        pin: accountValues.pin || undefined,
        notifications: values.notificationEntries ?? [],
        overdueBasis,
      });
      void appearance.refresh().catch(() => undefined);
      message.success('安装完成');
      form.resetFields();
      accountValuesRef.current = null;
      notificationValuesRef.current = {};
      setHasDraft(false);
      setStep(COMPLETE_STEP);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        form.resetFields();
        accountValuesRef.current = null;
        notificationValuesRef.current = {};
        setHasDraft(false);
        setStep(COMPLETE_STEP); // 已被并发安装
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
        background: 'var(--background)',
      }}
    >
      <SkinDecorations slot="background" />
      <Card className="auth-card setup-card" title={`${appName} · 安装向导`}>
        {isMobile ? <div className="setup-mobile-progress" aria-label={`步骤 ${step + 1} / ${SETUP_STEPS.length}：${SETUP_STEPS[step]}`}>
          <div><span>步骤 {step + 1} / {SETUP_STEPS.length}</span><strong>{SETUP_STEPS[step]}</strong></div>
          <div className="setup-progress-track" aria-hidden="true">{SETUP_STEPS.map((title, index) => <span key={title} className={index <= step ? 'is-complete' : undefined} />)}</div>
        </div> : <Steps
          size="small"
          current={step}
          responsive
          items={SETUP_STEPS.map(title => ({ title }))}
          style={{ marginBottom: 24 }}
        />}

        {step === 0 && (
          <>
            <div className="setup-check">
              <div className="setup-check-state">
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
              </div>
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
            <div className="setup-actions"><Button type="primary" disabled={!dbOk} onClick={() => setStep(1)}>
              下一步
            </Button></div>
          </>
        )}

        {step === 1 && (
          <Form onValuesChange={() => setHasDraft(true)} form={form} layout="vertical" autoFocus>
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
                  PIN 用于保护完整卡号、有效期和 CVV。忘记 PIN 后无法恢复这些信息；重置 PIN 会清空已保存的敏感信息。
                  <br />
                  暂不设置也可以完成安装，之后在系统设置中补设。
                </Typography.Text>
              }
              style={{ marginTop: 8 }}
            />

            <div className="setup-actions">
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button
                type="primary"
                onClick={() => {
                  void form
                    .validateFields(['password', 'confirm', 'pin', 'pinConfirm'])
                    .then((values) => {
                      accountValuesRef.current = {
                        password: values.password,
                        pin: values.pin,
                      };
                      setStep(2);
                    })
                    .catch(() => undefined);
                }}
              >
                下一步
              </Button>
            </div>
          </Form>
        )}

        {step === 2 && (
          <Form form={form} layout="vertical" initialValues={{ notificationEntries: notificationValuesRef.current.notificationEntries ?? [] }}
            onValuesChange={() => { setHasDraft(true); notificationValuesRef.current = { notificationEntries: structuredClone(form.getFieldValue('notificationEntries') ?? []) }; }}
            onFinish={() => {
              notificationValuesRef.current = { notificationEntries: structuredClone(form.getFieldValue('notificationEntries') ?? []) };
              setStep(3);
            }}>
            <Typography.Title className="setup-section-title" level={5}><BellOutlined /><span>选择通知渠道</span></Typography.Title>
            <SetupNotificationFields providers={status?.notificationProviders ?? []} />
            <Typography.Title className="setup-section-title" level={5}><BellOutlined /><span>逾期提醒</span></Typography.Title>
            <Typography.Text type="secondary">过了还款日之后，按哪种口径把账单当作逾期</Typography.Text>
            <div style={{ marginTop: 12 }}>
              <OverdueBasisRadio value={overdueBasis} onChange={setOverdueBasis} disabled={installing} name="setup-overdue-basis" />
            </div>
            <div className="setup-actions">
              <Button onClick={() => { notificationValuesRef.current = { notificationEntries: structuredClone(form.getFieldValue('notificationEntries') ?? []) }; setStep(1); }}>上一步</Button>
              <Button type="primary" htmlType="submit">下一步</Button>
            </div>
          </Form>
        )}

        {step === 3 && (
          <section className="setup-appearance" aria-label="外观主题">
            <div className="setup-color-mode"><h3>明暗模式</h3><ColorModeSwitch disabled={installing} /></div>
            <BuiltinSkinPicker value={skinId} disabled={installing} onChange={value => { setSkinId(value); setHasDraft(true); }} />
            <div className="setup-actions">
              <Button disabled={installing} onClick={() => setStep(2)}>上一步</Button>
              <Button type="primary" loading={installing} onClick={() => void onInstall()}>完成安装</Button>
            </div>
          </section>
        )}

        {step === COMPLETE_STEP && (
          <>
            <Alert type="success" showIcon title="安装完成！" style={{ marginBottom: 24 }} />
            <div className="setup-actions"><Button type="primary" size="large" onClick={onDone}>
              前往登录
            </Button></div>
          </>
        )}
      </Card>
    </div>
  );
}
