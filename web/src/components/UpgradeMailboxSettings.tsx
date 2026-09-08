import { useState } from 'react';
import { Alert, App, Button, Form, Modal } from 'antd';
import { api } from '../api/client';
import { useDraftGuard } from '../lib/draftGuard';
import { useResponsive } from '../responsive';
import { InlineConfirm } from './MobilePrimitives';
import { EmailAccountFields, type AccountFormValues, type EmailConnection } from './EmailAccountForm';

/** 邮箱设置是迁移的子弹窗；全部保存后返回上一级，由用户点“重试”，不自动启动迁移。 */
export default function UpgradeMailboxSettings({ accounts, onClose }: { accounts: EmailConnection[]; onClose: () => void }) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [form] = Form.useForm<{ accounts: AccountFormValues[] }>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDraftGuard(dirty);
  const cancel = () => { if (!saving) { if (dirty) setLeaveConfirm(true); else onClose(); } };
  const save = async () => {
    if (saving) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      setError(null);
      await api.put('/api/email/accounts/configurations', { accounts: values.accounts.map((value, i) => {
        const { authPassword, ...fields } = value;
        return { ...fields, id: accounts[i].id, ...(authPassword ? { authPassword } : {}) };
      }) });
      form.resetFields();
      setDirty(false);
      message.success('邮箱设置已保存，请点击重试继续升级');
      onClose();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setError(error instanceof Error ? error.message : '邮箱设置保存失败');
      }
    } finally { setSaving(false); }
  };

  return <Modal title="邮箱设置" open width={isMobile ? '100vw' : 'min(1000px, 94vw)'}
    className={isMobile ? 'email-account-mobile-modal' : 'upgrade-mailbox-settings'}
    style={isMobile ? { top: 0, maxWidth: '100vw', paddingBottom: 0 } : { top: 40 }}
    onCancel={cancel} maskClosable={false} closable={!saving} keyboard={!saving}
    footer={leaveConfirm ? null : <><Button disabled={saving} onClick={cancel}>取消</Button>
      <Button type="primary" loading={saving} onClick={() => void save()}>完成设置</Button></>}>
    <p>以下邮箱无法读取，请检查连接信息和授权码。设置完成后，返回升级窗口点击重试。</p>
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
    <Form form={form} name="upgrade-mailboxes" layout="vertical" autoComplete="off"
      initialValues={{ accounts }} onValuesChange={() => setDirty(true)} disabled={saving}>
      {accounts.map((account, index) => <section key={account.id} className="upgrade-mailbox-section" aria-label={account.email}>
        <h3>{account.email}</h3>
        <EmailAccountFields existing namePrefix={['accounts', index]} />
      </section>)}
    </Form>
    {leaveConfirm && <InlineConfirm title="放弃未保存的修改？" description="返回后，本次邮箱设置不会保存。"
      confirmText="放弃修改" onConfirm={onClose} onCancel={() => setLeaveConfirm(false)} />}
  </Modal>;
}
