import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Empty, Spin, Table, Tag, Typography } from 'antd';
import { Virtuoso } from 'react-virtuoso';
import type { BillDetails, ParsedTransaction } from '../api/types';
import { formatMoney } from '../lib/money';
import { MobileFlow } from './MobilePrimitives';
import './BillDetailsView.css';

export interface BillDetailsTarget {
  billId: number;
  bankName: string;
  cardTails: string[];
  period: string;
}

export function billCardTailsText(tails: string[]): string {
  if (tails.length <= 1) return tails[0] ?? '';
  return `${tails[0]} 等${tails.length}张卡`;
}

export function isAnnualFeeTransaction(transaction: ParsedTransaction): boolean {
  return transaction.amount > 0
    && /年费/.test(transaction.description)
    && !/退|返|冲|免|减/.test(transaction.description);
}

export function DesktopBillDetailsContent({
  details,
  loading,
  error,
  blocked,
  onRetry,
  onViewHistory,
}: {
  details: BillDetails | null;
  loading: boolean;
  error: string | null;
  blocked: boolean;
  onRetry: () => void;
  onViewHistory: () => void;
}) {
  if (loading) {
    return (
      <div className="bill-details-loading">
        <Spin />
        <Typography.Text type="secondary">正在读取账单明细…</Typography.Text>
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        title="账单明细加载失败"
        description={error}
        action={blocked ? <Button onClick={onViewHistory}>查看进度</Button> : <Button onClick={onRetry}>重试</Button>}
      />
    );
  }
  if (!details || details.transactions.length === 0) {
    return <Empty description="该账单未解析到交易明细" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const showCardTail = details.transactions.some((transaction) => transaction.cardLast4);
  return (
    <Table<ParsedTransaction>
      rowKey={(transaction, index) => String(transaction.id ?? index)}
      size="small"
      dataSource={details.transactions}
      pagination={false}
      scroll={{ y: 420 }}
      rowClassName={(transaction) => (isAnnualFeeTransaction(transaction) ? 'annual-fee-row' : '')}
      columns={[
        { title: '交易日', dataIndex: 'date', width: 110, render: (value) => value ?? '-' },
        ...(showCardTail
          ? [{ title: '卡尾', dataIndex: 'cardLast4', width: 70, render: (value?: string | null) => value ?? '-' } as const]
          : []),
        { title: '交易描述', dataIndex: 'description' },
        {
          title: '金额',
          dataIndex: 'amount',
          width: 110,
          align: 'right' as const,
          render: (value: number, row: ParsedTransaction) => (
            <Typography.Text type={value >= 0 ? 'danger' : 'success'}>
              {value >= 0 ? '' : '+'}
              {formatMoney(Math.abs(value), row.currency ?? details.currency)}
            </Typography.Text>
          ),
        },
      ]}
      summary={(rows) => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={showCardTail ? 4 : 3}>
            共 {rows.length} 笔
            {details.annualFeeAmount != null && details.annualFeeAmount > 0 && (
              <Tag color="red" style={{ marginLeft: 8 }}>
                含年费 {formatMoney(details.annualFeeAmount, details.currency)}
              </Tag>
            )}
          </Table.Summary.Cell>
        </Table.Summary.Row>
      )}
    />
  );
}

export function MobileBillDetails({
  target,
  details,
  loading,
  error,
  blocked,
  blockedReason,
  onBack,
  onRetry,
  onViewHistory,
}: {
  target: BillDetailsTarget;
  details: BillDetails | null;
  loading: boolean;
  error: string | null;
  blocked: boolean;
  blockedReason: string;
  onBack: () => void;
  onRetry: () => void;
  onViewHistory: () => void;
}) {
  const detailsListRef = useRef<HTMLDivElement | null>(null);
  const [detailsScrollParent, setDetailsScrollParent] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setDetailsScrollParent(
      detailsListRef.current?.closest('.mobile-flow-screen') as HTMLElement | null,
    );
  }, [details?.transactions.length]);

  let content: ReactNode;
  if (loading) {
    content = (
      <div className="bill-details-loading bill-details-loading-mobile">
        <Spin />
        <Typography.Text type="secondary">正在读取账单明细…</Typography.Text>
      </div>
    );
  } else if (error) {
    content = (
      <Alert
        type="error"
        showIcon
        title="账单明细加载失败"
        description={error}
        action={blocked ? <Button onClick={onViewHistory}>查看进度</Button> : <Button onClick={onRetry}>重试</Button>}
      />
    );
  } else if (!details || details.transactions.length === 0) {
    content = <Empty description="该账单未解析到交易明细" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  } else {
    content = (
      <div ref={detailsListRef} className="mobile-bill-details-list">
        <Card size="small">
          共 {details.transactions.length} 笔
          {details.annualFeeAmount != null && details.annualFeeAmount > 0 && (
            <Tag color="red" style={{ marginLeft: 8 }}>
              含年费 {formatMoney(details.annualFeeAmount, details.currency)}
            </Tag>
          )}
        </Card>
        {detailsScrollParent == null ? (
          <div className="mobile-bill-details-preparing"><Spin size="small" /> 正在准备交易明细</div>
        ) : (
          <Virtuoso
            customScrollParent={detailsScrollParent}
            data={details.transactions}
            computeItemKey={(index, transaction) => String(transaction.id ?? `${transaction.date ?? 'date'}-${index}`)}
            defaultItemHeight={132}
            increaseViewportBy={{ top: 260, bottom: 520 }}
            itemContent={(index, transaction) => (
              <div className="mobile-bill-detail-item" data-transaction-index={index}>
                <Card
                  size="small"
                  style={isAnnualFeeTransaction(transaction) ? { borderColor: '#ff7875' } : undefined}
                  title={transaction.date || '交易日期未提供'}
                  extra={transaction.cardLast4 ? <Tag>尾号 {transaction.cardLast4}</Tag> : null}
                >
                  <Typography.Paragraph style={{ marginBottom: 8 }}>{transaction.description}</Typography.Paragraph>
                  <Typography.Text type={transaction.amount >= 0 ? 'danger' : 'success'} className="amount-strong">
                    {transaction.amount >= 0 ? '' : '+'}
                    {formatMoney(Math.abs(transaction.amount), transaction.currency ?? details.currency)}
                  </Typography.Text>
                  {isAnnualFeeTransaction(transaction) && <Tag color="red" style={{ marginLeft: 8 }}>年费</Tag>}
                </Card>
              </div>
            )}
          />
        )}
      </div>
    );
  }

  return (
    <MobileFlow title="账单明细" onBack={onBack}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {target.bankName}（{billCardTailsText(target.cardTails)}）{target.period}期
      </Typography.Title>
      {blocked && details && !loading && (
        <Alert
          type="warning"
          showIcon
          title={blockedReason}
          description="这份已经加载的明细可以继续查看；新的明细读取需等待历史拉取结束。"
          action={<Button onClick={onViewHistory}>查看进度</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {content}
    </MobileFlow>
  );
}
