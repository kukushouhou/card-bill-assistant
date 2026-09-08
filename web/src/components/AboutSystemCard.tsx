import { useEffect, useState } from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { CreditCardOutlined, ExportOutlined, GithubOutlined } from '@ant-design/icons';
import { useAppName, useAppVersion } from '../appName';
import { api } from '../api/client';
import type { StatementRepairResult } from '../api/types';
import UpgradeResultSummary from './UpgradeResultSummary';

export default function AboutSystemCard() {
  const name = useAppName(), version = useAppVersion();
  const [result, setResult] = useState<StatementRepairResult | null>(null);
  const [error, setError] = useState(false);
  const load = () => { setError(false); void api.get<StatementRepairResult | null>('/api/upgrades/latest-result')
    .then((value) => setResult(value?.counts ? value : null)).catch(() => setError(true)); };
  useEffect(load, []);
  return <section className="settings-about" aria-labelledby="settings-about-title">
    <h2 id="settings-about-title">关于本系统</h2>
    <div className="settings-about-brand">
      <CreditCardOutlined className="settings-about-mark" aria-hidden="true" />
      <div>
        <h3>{name}</h3>
        <Typography.Paragraph className="settings-about-tagline">自己的信用卡账单与还款提醒助手</Typography.Paragraph>
      </div>
    </div>
    <Typography.Paragraph className="settings-about-version">{version ? `版本 v${version}` : '版本信息暂未获取'}</Typography.Paragraph>
    <Typography.Paragraph className="settings-about-description">从银行邮件导入账单，整理交易明细，提醒每一次还款。支持多张卡片与多种通知方式，数据保存在自己的服务器中。</Typography.Paragraph>
    <Space wrap>
      <Button icon={<GithubOutlined aria-hidden="true" />} href="https://github.com/kukushouhou/card-bill-assistant" target="_blank" rel="noopener noreferrer">GitHub 项目</Button>
      <Button icon={<ExportOutlined aria-hidden="true" />} href="https://github.com/kukushouhou/card-bill-assistant/releases" target="_blank" rel="noopener noreferrer">检查更新</Button>
    </Space>
    <footer className="settings-about-footer">
      <span>© 2026 kukushouhou</span>
      <span>本项目基于 <Typography.Link href="https://github.com/kukushouhou/card-bill-assistant/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT 许可证</Typography.Link>开源。</span>
    </footer>
    {result && <div className="settings-about-upgrade"><UpgradeResultSummary result={result} /></div>}
    {error && <Alert style={{ marginTop: 16 }} type="info" title="最近升级结果暂未读取" action={<Button size="small" onClick={load}>重试</Button>} />}
  </section>;
}
