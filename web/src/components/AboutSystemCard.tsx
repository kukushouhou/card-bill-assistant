import { Button, Card, Typography } from 'antd';
import { ExportOutlined, GithubOutlined, InfoCircleOutlined, QuestionCircleOutlined, SafetyOutlined } from '../skins/icons';
import { useAppName, useAppVersion } from '../appName';

const projectUrl = 'https://github.com/kukushouhou/card-bill-assistant';

export default function AboutSystemCard() {
  const name = useAppName(), version = useAppVersion();
  return <section className="settings-about" aria-labelledby="settings-about-title">
    <Card className="settings-card" title={<span id="settings-about-title">关于本系统</span>}
      extra={<Typography.Text type="secondary" className="settings-about-version">{version ? `版本 v${version}` : '版本信息暂未获取'}</Typography.Text>}>
      <div className="settings-about-intro">
        <div className="settings-about-brand">
          <h3>{name}</h3>
          <Typography.Paragraph className="settings-about-tagline">信用卡账单与还款提醒助手</Typography.Paragraph>
        </div>
        <div className="settings-about-actions">
          <Button icon={<GithubOutlined aria-hidden="true" />} href={projectUrl} target="_blank" rel="noopener noreferrer">GitHub 项目</Button>
          <Button icon={<ExportOutlined aria-hidden="true" />} href={`${projectUrl}/releases`} target="_blank" rel="noopener noreferrer">检查更新</Button>
        </div>
      </div>
      <div className="settings-about-notes">
        <p><InfoCircleOutlined className="settings-about-notice" aria-hidden="true" /><span>本系统不会代扣还款，请以银行账单为准。</span></p>
        <p><SafetyOutlined className="settings-about-security" aria-hidden="true" /><span>卡信息加密保存，PIN 不留存，请妥善保管。</span></p>
        <p><QuestionCircleOutlined aria-hidden="true" /><span>需要帮助？<Typography.Link href={`${projectUrl}#readme`} target="_blank" rel="noopener noreferrer">查看使用文档</Typography.Link>，或<Typography.Link href={`${projectUrl}/issues`} target="_blank" rel="noopener noreferrer">反馈问题</Typography.Link>。</span></p>
      </div>
      <footer className="settings-about-footer">
        <span>© 2026 kukushouhou</span>
        <span>本项目基于 <Typography.Link href={`${projectUrl}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT 许可证</Typography.Link>开源。</span>
      </footer>
    </Card>
  </section>;
}
