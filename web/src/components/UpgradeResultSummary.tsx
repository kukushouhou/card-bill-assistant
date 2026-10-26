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
    {c.unavailableMails > 0 && <Alert type="warning" showIcon style={{ marginTop: 12 }}
      title={`${c.unavailableMails} 封邮件的${result.kind === 'icbc-foreign' ? '账单未修正' : '明细未补齐'}`}
      description={result.kind === 'icbc-foreign'
        ? '相关账单保留原状。未修正数量不代表仍有错误账单；原文未列出对应外币应还金额时，也会保留现有记录。'
        : <div>{[...new Set(result.incomplete.map((row) => row.bankName))].join('、')}的部分原文无法完整读取，相关明细保留原状。</div>} />}
    {(c.uncertainRepayments ?? 0) > 0 && <Alert type="warning" showIcon style={{ marginTop: 12 }}
      title={`${c.uncertainRepayments} 笔账单金额已修正，还款状态未变`}
      description="现有记录不足以确认这些账单是否曾被系统自动标为已还清，因此保留原还款状态，未自动恢复待还。" />}
  </div>;
}
