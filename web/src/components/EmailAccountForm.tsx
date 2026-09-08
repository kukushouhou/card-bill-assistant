import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import type { EmailAccount } from '../api/types';
import { useDraftGuard } from '../lib/draftGuard';
import { useResponsive, useResetOnModeChange } from '../responsive';
import SettingSwitch from './SettingSwitch';
import { InlineConfirm, MobileFlow } from './MobilePrimitives';
import '../pages/email.css';

export type EmailConnection = Pick<EmailAccount, 'id' | 'email' | 'imapHost' | 'imapPort' | 'tls' | 'authUser'>;
export interface AccountFormValues {
  email: string;
  imapHost: string;
  imapPort: number;
  tls: boolean;
  authUser: string;
  authPassword?: string;
}

export interface AccountFormDraft {
  values: Partial<AccountFormValues>;
  dirty: boolean;
}

function accountFormInitialValues(initial?: EmailConnection | null): Partial<AccountFormValues> {
  if (!initial) return { imapPort: 993, tls: true };
  return {
    email: initial.email,
    imapHost: initial.imapHost,
    imapPort: initial.imapPort,
    tls: initial.tls,
    authUser: initial.authUser,
  };
}

function definedAccountDraft(values?: Partial<AccountFormValues>): Partial<AccountFormValues> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<AccountFormValues>;
}

function normalizedAccountFormValues(values: Partial<AccountFormValues>) {
  return {
    email: values.email ?? '',
    imapHost: values.imapHost ?? '',
    imapPort: values.imapPort ?? null,
    tls: values.tls ?? false,
    authUser: values.authUser ?? '',
    authPassword: values.authPassword ?? '',
  };
}

function accountFormChanged(values: Partial<AccountFormValues>, baseline: Partial<AccountFormValues>): boolean {
  return JSON.stringify(normalizedAccountFormValues(values)) !== JSON.stringify(normalizedAccountFormValues(baseline));
}

const PRESETS: Array<{ host: string; label: string }> = [
  { host: 'imap.qq.com', label: 'QQ 邮箱（imap.qq.com）' },
  { host: 'imap.163.com', label: '网易 163（imap.163.com）' },
  { host: 'imap.gmail.com', label: 'Gmail（imap.gmail.com）' },
  { host: 'imap.aliyun.com', label: '阿里云邮箱（imap.aliyun.com）' },
  { host: 'imap.126.com', label: '网易 126（imap.126.com）' },
];

/** 初次绑定、单邮箱编辑和迁移内多邮箱设置共用同一套连接/登录字段。 */
export function EmailAccountFields({ existing = false, namePrefix = [] }: { existing?: boolean; namePrefix?: Array<string | number> }) {
  const field = (name: string) => [...namePrefix, name];
  return (<div className="email-editor-grid"><section><h3>邮箱连接</h3>
        <Form.Item
          name={field('email')}
          label="邮箱地址"
          rules={[{ required: true, type: 'email', message: '邮箱格式错误' }]}
        >
          <Input placeholder="you@example.com" autoComplete="off" />
        </Form.Item>
        <Form.Item name={field('imapHost')} label="IMAP 服务器" rules={[{ required: true, message: '必填' }]}>
          <Select
            showSearch
            options={PRESETS.map((p) => ({ value: p.host, label: p.label }))}
            placeholder="选择或输入服务器地址"
          />
        </Form.Item>
        <div className="email-connection-fields">
          <Form.Item name={field('imapPort')} label="端口" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name={field('tls')} label="SSL/TLS" valuePropName="checked">
            <SettingSwitch aria-label="SSL/TLS" />
          </Form.Item>
        </div>
        </section><section><h3>登录信息</h3>
        <Form.Item name={field('authUser')} label="登录账号" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="通常为邮箱地址" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name={field('authPassword')}
          label={existing ? '授权码（留空则不修改）' : '授权码 / 密码'}
          rules={existing ? [] : [{ required: true, message: '必填' }]}
        >
          <Input.Password placeholder="IMAP 授权码" autoComplete="new-password" />
        </Form.Item>
        </section></div>
  );
}

export default function AccountForm({
  initial,
  onOk,
  onCancel,
  confirmLoading,
  disabled,
  draft,
  onDraftChange,
}: {
  initial?: EmailConnection | null;
  onOk: (values: AccountFormValues, test: boolean) => Promise<void>;
  onCancel: () => void;
  confirmLoading: boolean;
  disabled: boolean;
  draft: AccountFormDraft | null;
  onDraftChange: (draft: AccountFormDraft) => void;
}) {
  const [form] = Form.useForm<AccountFormValues>();
  const [testing, setTesting] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const { isMobile } = useResponsive();
  const baseline = useRef(accountFormInitialValues(initial)).current;
  const formInitialValues = useRef({
    ...baseline,
    ...definedAccountDraft(draft?.values),
  }).current;
  const busyRef = useRef(false);

  useResetOnModeChange(() => setLeaveConfirm(false));

  // 使用唯一表单名隔离浏览器表单恢复，再显式写入一次，避免新建页的空值覆盖编辑页预填。
  useEffect(() => {
    form.setFieldsValue(formInitialValues);
  }, [form, formInitialValues]);

  const submit = async (test: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const values = await form.validateFields();
      if (test) {
        setTesting(true);
        await onOk(values, true);
      } else {
        await onOk(values, false);
      }
    } catch (error) {
      // AntD 字段校验失败已经在字段旁展示，不制造未处理 Promise。
      if (!(error && typeof error === 'object' && 'errorFields' in error)) throw error;
    } finally {
      busyRef.current = false;
      setTesting(false);
    }
  };

  useDraftGuard(Boolean(draft?.dirty));

  const requestCancel = () => {
    if (confirmLoading || testing || busyRef.current) return;
    if (draft?.dirty) {
      setLeaveConfirm(true);
      return;
    }
    onCancel();
  };

  const content = (
    <>
      {disabled && <Alert type="warning" showIcon title="历史拉取进行中，暂时不能变更邮箱账户" />}
      <Typography.Paragraph type="secondary">
        使用 IMAP 只读方式拉取账单邮件（不标记已读、不删信）。QQ/163 等需先在邮箱设置中开启 IMAP 并使用授权码。
      </Typography.Paragraph>
      <Form
        form={form}
        name={initial ? `email-account-${initial.id}` : 'email-account-new'}
        layout="vertical"
        autoComplete="off"
        initialValues={formInitialValues}
        onValuesChange={(_, values) =>
          onDraftChange({ values, dirty: accountFormChanged(values, baseline) })
        }
      >
        <EmailAccountFields existing={!!initial} />
      </Form>
    </>
  );

  const footer = leaveConfirm ? undefined : isMobile ? (
    <div className="mobile-email-editor-actions">
      <div className="mobile-email-editor-aux-row">
        <Button
          type="text"
          onClick={() => void submit(true)}
          loading={testing}
          disabled={disabled || confirmLoading}
        >
          测试连接
        </Button>
      </div>
      <div className="mobile-email-editor-main-row">
        <Button onClick={requestCancel} disabled={confirmLoading || testing}>
          取消
        </Button>
        <Button
          type="primary"
          onClick={() => void submit(false)}
          loading={confirmLoading}
          disabled={disabled || testing}
        >
          保存
        </Button>
      </div>
    </div>
  ) : (
    <Space direction="horizontal">
      <Button
        onClick={() => void submit(true)}
        loading={testing}
        disabled={disabled || confirmLoading}
      >
        测试连接
      </Button>
      <Button
        type="primary"
        onClick={() => void submit(false)}
        loading={confirmLoading}
        disabled={disabled || testing}
      >
        保存
      </Button>
      <Button onClick={requestCancel} disabled={confirmLoading || testing}>
        取消
      </Button>
    </Space>
  );

  const title = initial ? `编辑邮箱 - ${initial.email}` : '绑定邮箱账户';
  if (isMobile) {
    return (
      <MobileFlow title={initial ? '编辑邮箱' : '绑定邮箱'} onBack={requestCancel} footer={footer}>
        <Typography.Title level={5}>{title}</Typography.Title>
        {content}
        {leaveConfirm && (
          <InlineConfirm
            title="放弃未保存的更改？"
            description="返回后，本次填写的邮箱账户信息不会保存。"
            confirmText="放弃更改"
            danger={false}
            onConfirm={onCancel}
            onCancel={() => setLeaveConfirm(false)}
          />
        )}
      </MobileFlow>
    );
  }

  return (
    <Modal title={title} open width="min(1000px, 94vw)" onCancel={requestCancel} destroyOnHidden footer={footer}>
      {leaveConfirm && <InlineConfirm title="放弃未保存的修改？" description="退出后本次修改不会保存。" confirmText="放弃修改" onConfirm={onCancel} onCancel={() => setLeaveConfirm(false)} />}
      {content}
    </Modal>
  );
}
