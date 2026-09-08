import { Alert, Space, Tag, Typography } from 'antd';
import type { StatementRepairResult } from '../api/types';

export default function UpgradeResultSummary({ result }: { result: StatementRepairResult }) {
  const c = result.counts;
  return <div className="upgrade-result-summary">
    <Typography.Paragraph>v{result.version} 账单修复结果</Typography.Paragraph>
    <Space wrap>
      <Tag>修正账单 {c.correctedBills} 笔</Tag><Tag>补建账单 {c.addedBills} 笔</Tag>
      <Tag>新增明细 {c.addedTransactions} 条</Tag><Tag>修正明细 {c.correctedTransactions} 条</Tag>
      <Tag>移除错误明细 {c.removedTransactions} 条</Tag><Tag>恢复待还 {c.restoredRepayments} 笔</Tag>
    </Space>
    {c.fallbackMinimumBills > 0 && <Typography.Paragraph style={{ marginTop: 12 }}>
      {c.fallbackMinimumBills} 笔中信账单未能取得原文，最低还款已按修正后的应还总额恢复。
    </Typography.Paragraph>}
    {c.unavailableMails > 0 && <Alert type="warning" showIcon style={{ marginTop: 12 }} title={`${c.unavailableMails} 封邮件的明细未补齐`}
      description={<div>{[...new Set(result.incomplete.map((row) => row.bankName))].join('、')}的部分原文无法完整读取，相关明细保留原状。</div>} />}
  </div>;
}
