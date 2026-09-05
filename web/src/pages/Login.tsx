import { SkinDecorations } from '../skins/SkinProvider';
import { useRef, useState } from 'react';
import { Button, Card, Form, Input, App } from 'antd';
import { LockOutlined, UserOutlined } from '../skins/icons';
import { api, ApiError } from '../api/client';
import { useAppName } from '../appName';
import { useResponsive } from '../responsive';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const { message } = App.useApp();
  const appName = useAppName();
  const { isMobile } = useResponsive();
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const onFinish = async (values: { password: string }) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await api.post('/api/auth/login', { username: 'admin', password: values.password });
      message.success('登录成功');
      onSuccess();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '登录失败');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <div
      className={`auth-screen ${isMobile ? 'auth-screen-mobile' : 'auth-screen-desktop'}`}
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--background)',
      }}
    >
      <SkinDecorations slot="background" />
      <Card className="auth-card login-card" title={appName} variant="outlined">
        <Form layout="vertical" onFinish={onFinish} autoFocus>
          <Form.Item label="管理员账号">
            <Input prefix={<UserOutlined />} value="admin" readOnly variant="filled" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
