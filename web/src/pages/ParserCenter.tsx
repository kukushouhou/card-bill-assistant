import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Form,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { BankOutlined, EyeOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { formatMoney } from '../lib/money';
import { Virtuoso } from 'react-virtuoso';
import { api, ApiError } from '../api/client';
import type { DryRunResult, EmailAccount, MailBody, ParserInfo } from '../api/types';
import { Page } from '../components/Layout';
import { useResponsive, useResetOnModeChange } from '../responsive';
import { useHistoryGate } from '../historyGate';
import { MobileFlow, MobilePullToRefresh, useCoalescedRefresh } from '../components/MobilePrimitives';
import './parser-center.css';

export default function ParserCenter() {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const historyGate = useHistoryGate();
  const [parsers, setParsers] = useState<ParserInfo[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [running, setRunning] = useState(false);
  const [resultSession, setResultSession] = useState<{ accountId: number; results: DryRunResult[] } | null>(null);
  const [viewing, setViewing] = useState<{ accountId: number; uid: number } | null>(null);
  const [viewBody, setViewBody] = useState<MailBody | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resultPage, setResultPage] = useState(1);
  const [mobileScrollParent, setMobileScrollParent] = useState<HTMLElement | null>(null);
  const [accountSelectOpen, setAccountSelectOpen] = useState(false);
  const [parserSelectOpen, setParserSelectOpen] = useState(false);
  const viewGeneration = useRef(0);
  const runningRef = useRef(false);
  const viewLoadingRef = useRef(false);
  const [form] = Form.useForm<{ accountId: number; mode: 'count' | 'days'; limit: number; sinceDays: number; parserId?: string }>();

  const parserGroups = useMemo(() => {
    const groups = new Map<string, ParserInfo[]>();
    for (const parser of parsers) {
      const group = groups.get(parser.bankName);
      if (group) group.push(parser);
      else groups.set(parser.bankName, [parser]);
    }
    return [...groups.entries()].map(([bankName, items]) => ({ bankName, items }));
  }, [parsers]);

  useResetOnModeChange(() => {
    setAccountSelectOpen(false);
    setParserSelectOpen(false);
  });

  useEffect(() => {
    if (!isMobile) {
      setMobileScrollParent(null);
      return;
    }

    setMobileScrollParent(document.getElementById('root'));
  }, [isMobile]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [p, a] = await Promise.all([
        api.get<ParserInfo[]>('/api/email/parsers'),
        api.get<EmailAccount[]>('/api/email/accounts'),
      ]);
      setParsers(p);
      setAccounts(a);
    } catch (error) {
      const text = error instanceof ApiError || error instanceof Error ? error.message : '加载失败';
      setLoadError(text);
      throw error;
    }
  }, []);

  const refresh = useCoalescedRefresh(load);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    // 账户数据出现后，试解析表单已经随当前渲染完成挂载，再连接默认账户，避免操作未挂载的 useForm 实例。
    if (accounts.length > 0 && form.getFieldValue('accountId') == null) {
      form.setFieldValue('accountId', accounts[0].id);
    }
  }, [accounts, form]);

  const run = async () => {
    if (runningRef.current || !historyGate.mayRunRestrictedAction()) {
      if (!historyGate.mayRunRestrictedAction()) message.warning(historyGate.blockedReason);
      return;
    }
    runningRef.current = true;
    let values: Awaited<ReturnType<typeof form.validateFields>>;
    try {
      values = await form.validateFields();
    } catch {
      runningRef.current = false;
      return;
    }
    if (!historyGate.mayRunRestrictedAction()) {
      runningRef.current = false;
      message.warning(historyGate.blockedReason);
      return;
    }
    setRunning(true);
    try {
      const r = await api.post<{ results: DryRunResult[] }>('/api/email/dry-run', {
        accountId: values.accountId,
        limit: values.mode === 'days' ? 1000 : values.limit,
        parserId: values.parserId || undefined,
        sinceDays: values.mode === 'days' ? values.sinceDays : undefined,
      });
      setResultSession({ accountId: values.accountId, results: r.results });
      setResultPage(1);
      const parsed = r.results.filter((x) => x.parsed).length;
      message.info(`试解析完成：${r.results.length} 封中 ${parsed} 封可解析`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '执行失败');
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const viewMail = async (accountId: number, uid: number) => {
    if (viewLoadingRef.current || !historyGate.mayRunRestrictedAction()) {
      if (!historyGate.mayRunRestrictedAction()) message.warning(historyGate.blockedReason);
      return;
    }
    viewLoadingRef.current = true;
    if (!historyGate.mayRunRestrictedAction()) {
      viewLoadingRef.current = false;
      message.warning(historyGate.blockedReason);
      return;
    }
    const generation = ++viewGeneration.current;
    setViewing({ accountId, uid });
    setViewBody(null);
    setViewLoading(true);
    try {
      const body = await api.get<MailBody>(`/api/email/accounts/${accountId}/messages/${uid}`);
      if (generation === viewGeneration.current) setViewBody(body);
    } catch (err) {
      if (generation !== viewGeneration.current) return;
      message.error(err instanceof ApiError ? err.message : '读取原文失败');
      setViewing(null);
    } finally {
      if (generation === viewGeneration.current) {
        viewLoadingRef.current = false;
        setViewLoading(false);
      }
    }
  };

  const closeMail = () => {
    viewGeneration.current += 1;
    viewLoadingRef.current = false;
    setViewing(null);
    setViewBody(null);
    setViewLoading(false);
  };

  const mailContent = (
    <>
      {viewLoading && <div className="mobile-section-loading"><Spin /></div>}
      {viewBody && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="主题">{viewBody.subject}</Descriptions.Item>
            <Descriptions.Item label="发件人">{viewBody.from}</Descriptions.Item>
            <Descriptions.Item label="日期">{dayjs(viewBody.date).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
            {viewBody.attachments.length > 0 && (
              <Descriptions.Item label="附件">
                {viewBody.attachments.map((attachment) => (
                  <Tag key={attachment.filename}>
                    {attachment.filename}（{(attachment.size / 1024).toFixed(0)}KB）
                  </Tag>
                ))}
              </Descriptions.Item>
            )}
          </Descriptions>
          <pre className="mail-body-content">
            {viewBody.pdfText || viewBody.text || '(无纯文本内容)'}
          </pre>
        </Space>
      )}
    </>
  );

  if (isMobile && viewing) {
    return (
      <MobileFlow title="邮件原文" onBack={closeMail} footer={<Button block onClick={closeMail}>返回解析结果</Button>}>
        {mailContent}
      </MobileFlow>
    );
  }

  return (
    <Page
      title="解析器中心"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void refresh().catch(() => undefined)}>
          刷新
        </Button>
      }
    >
      <MobilePullToRefresh onRefresh={refresh}>
        <div className="parser-page-content">
      {loadError && (
        <Alert
          type="error"
          showIcon
          title={loadError}
          action={<Button onClick={() => void refresh().catch(() => undefined)}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {historyGate.blocked && (
        <Alert
          type="warning"
          showIcon
          title={historyGate.blockedReason}
          description="已加载的结果与原文仍可查看；试解析和新开邮件原文暂不可用。"
          style={{ marginBottom: 12 }}
        />
      )}
      <Card
        title="已注册解析器"
        extra={<Tag variant="filled">{parsers.length} 个解析器</Tag>}
        size="small"
        className="parser-catalog-card"
        style={{ marginBottom: 16 }}
        variant="outlined"
      >
        {parsers.length === 0 ? (
          <Empty description="暂无解析器" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            <div className="parser-catalog-intro">
              <Typography.Text type="secondary">
                按银行查看已支持的账单模板，展开解析器可查看完整匹配规则。
              </Typography.Text>
              <div className="parser-catalog-stats" aria-label="解析器统计">
                <span><strong>{parserGroups.length}</strong> 家银行</span>
                <span><strong>{parsers.length}</strong> 个模板</span>
              </div>
            </div>

            <div className="parser-bank-grid">
              {parserGroups.map(({ bankName, items }) => (
                <section key={bankName} className="parser-bank-card">
                  <div className="parser-bank-header">
                    <span className="parser-bank-icon" aria-hidden="true"><BankOutlined /></span>
                    <div className="parser-bank-heading">
                      <Typography.Text strong>{bankName}</Typography.Text>
                      <Typography.Text type="secondary">{items.length} 个版本</Typography.Text>
                    </div>
                  </div>

                  <Collapse
                    bordered={false}
                    expandIconPlacement="end"
                    className="parser-bank-collapse"
                    items={items.map((parser, parserIndex) => {
                      const version = parser.id.match(/(20\d{2})$/)?.[1];
                      const ruleCount = parser.senderPatterns.length + parser.subjectPatterns.length;
                      const isPreferred = parserIndex === 0;
                      return {
                        key: parser.id,
                        label: (
                          <div className="parser-summary">
                            <div className="parser-summary-identity">
                              <Typography.Text code className="parser-id">{parser.id}</Typography.Text>
                              {version && <span className="parser-version">{version} 模板</span>}
                            </div>
                            <div className="parser-summary-meta">
                              <Tag variant="filled" color={isPreferred ? 'green' : 'default'}>
                                {isPreferred ? '优先匹配' : '降级兼容'}
                              </Tag>
                              <span>{ruleCount} 项规则</span>
                            </div>
                          </div>
                        ),
                        children: (
                          <div className="parser-rule-detail">
                            <div className="parser-rule-block">
                              <div className="parser-rule-heading">
                                <Typography.Text strong>发件人范围</Typography.Text>
                                <Typography.Text type="secondary">{parser.senderPatterns.length} 项</Typography.Text>
                              </div>
                              <div className="parser-pattern-list">
                                {parser.senderPatterns.map((pattern) => (
                                  <Tag key={pattern} className="parser-pattern-tag">{pattern}</Tag>
                                ))}
                              </div>
                            </div>

                            <div className="parser-rule-block">
                              <div className="parser-rule-heading">
                                <Typography.Text strong>标题范围</Typography.Text>
                                <Typography.Text type="secondary">{parser.subjectPatterns.length} 项</Typography.Text>
                              </div>
                              {parser.subjectPatterns.length > 0 ? (
                                <div className="parser-pattern-list">
                                  {parser.subjectPatterns.map((pattern) => (
                                    <Tag key={pattern} className="parser-pattern-tag parser-regexp-tag">/{pattern}/</Tag>
                                  ))}
                                </div>
                              ) : (
                                <Typography.Text type="secondary">未设置标题规则</Typography.Text>
                              )}
                            </div>
                          </div>
                        ),
                      };
                    })}
                  />
                </section>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card title="试解析最近邮件（不影响数据）" size="small" variant="outlined">
        {accounts.length === 0 ? (
          <Empty description="请先在「邮箱绑定」页绑定邮箱账户" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            <Form
              form={form}
              initialValues={{ mode: 'count', limit: 50, sinceDays: 90 }}
              layout={isMobile ? 'vertical' : 'inline'}
              className={isMobile ? 'mobile-parser-form' : undefined}
              style={{ marginBottom: 16 }}
            >
              <Form.Item name="accountId" label="邮箱账户" rules={[{ required: true, message: '必选' }]}>
                <Select
                  open={accountSelectOpen}
                  onOpenChange={setAccountSelectOpen}
                  style={{ width: isMobile ? '100%' : 220 }}
                  options={accounts.map((a) => ({ value: a.id, label: a.email }))}
                />
              </Form.Item>
              <Form.Item name="parserId" label="指定解析器">
                <Select
                  allowClear
                  open={parserSelectOpen}
                  onOpenChange={setParserSelectOpen}
                  placeholder="自动匹配"
                  style={{ width: isMobile ? '100%' : 160 }}
                  options={parsers.map((p) => ({ value: p.id, label: `${p.bankName} (${p.id})` }))}
                />
              </Form.Item>
              <Form.Item name="mode">
                <Radio.Group
                  options={[
                    { value: 'count', label: '最近 N 封' },
                    { value: 'days', label: '近 N 天' },
                  ]}
                  optionType="button"
                />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.mode !== b.mode}>
                {({ getFieldValue }) =>
                  getFieldValue('mode') === 'days' ? (
                    <Form.Item name="sinceDays" rules={[{ required: true }]} style={{ marginRight: isMobile ? 0 : 8 }}>
                      <InputNumber min={1} max={365} suffix="天" style={{ width: isMobile ? '100%' : 120 }} />
                    </Form.Item>
                  ) : (
                    <Form.Item name="limit" rules={[{ required: true }]} style={{ marginRight: isMobile ? 0 : 8 }}>
                      <InputNumber min={1} max={1000} suffix="封" style={{ width: isMobile ? '100%' : 130 }} />
                    </Form.Item>
                  )
                }
              </Form.Item>
              <Form.Item className={isMobile ? 'mobile-parser-submit-item' : undefined}>
                <Button
                  className={isMobile ? 'mobile-parser-submit-button' : undefined}
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={() => void run()}
                  loading={running}
                  disabled={historyGate.blocked}
                >
                  开始试解析
                </Button>
              </Form.Item>
            </Form>

            {running && <Spin description="拉取邮件并解析中…"><div style={{ height: 60 }} /></Spin>}

            {resultSession && isMobile && (
              <div className="mobile-parser-results">
                <div className="mobile-parser-results-heading">
                  <div>
                    <Typography.Text strong>试解析结果</Typography.Text>
                    <Typography.Text type="secondary">
                      {resultSession.results.filter((result) => result.parsed).length} 封成功
                    </Typography.Text>
                  </div>
                  <Tag variant="filled">{resultSession.results.length} 封邮件</Tag>
                </div>
                {resultSession.results.length === 0 ? (
                  <Empty description="没有可展示的试解析结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : mobileScrollParent == null ? (
                  <div className="mobile-parser-results-preparing" aria-label="正在准备试解析结果列表">
                    <Spin size="small" />
                    <Typography.Text type="secondary">正在准备结果列表</Typography.Text>
                  </div>
                ) : (
                  <Virtuoso
                    className="mobile-parser-results-virtuoso"
                    aria-label="试解析结果列表"
                    customScrollParent={mobileScrollParent}
                    data={resultSession.results}
                    defaultItemHeight={250}
                    increaseViewportBy={{ top: 360, bottom: 640 }}
                    computeItemKey={(_, result) => result.uid}
                    components={{
                      Footer: () => (
                        <div className="mobile-parser-results-footer">
                          已展示全部 {resultSession.results.length} 封邮件
                        </div>
                      ),
                    }}
                    itemContent={(_, result) => (
                      <div className="mobile-parser-result-item">
                        <Card className="mobile-entity-card mobile-parser-result-card" size="small">
                          <div className="mobile-entity-heading mobile-parser-result-title">
                            <Typography.Text strong>{result.subject || '（无主题）'}</Typography.Text>
                            {result.parsed ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>}
                          </div>
                          <div className="mobile-parser-result-meta">
                            <Typography.Text type="secondary">
                              UID {result.uid} · {dayjs(result.date).format('MM-DD HH:mm')}
                            </Typography.Text>
                            <Typography.Text type="secondary">{result.from}</Typography.Text>
                          </div>
                          <div className="mobile-parser-result-parser">
                            {result.parserId ? <Tag color="blue">{result.parserId}</Tag> : <Tag>未匹配解析器</Tag>}
                          </div>
                          {result.bills && result.bills.length > 0 ? (
                            <Space className="mobile-parser-result-bills" direction="vertical" size={4}>
                              {result.bills.map((bill, index) => (
                                <Typography.Text key={index}>
                                  {bill.bankName}（{bill.cardLast4}）{bill.period} 期 {formatMoney(bill.amount, bill.currency)}，还款日 {dayjs(bill.dueDate).format('MM-DD')}
                                  {bill.holderName ? `，${bill.holderName}` : ''}
                                </Typography.Text>
                              ))}
                            </Space>
                          ) : (result.currentCycleTransactionCount ?? 0) > 0 ? (
                            <Typography.Text>未出账明细 {result.currentCycleTransactionCount} 笔</Typography.Text>
                          ) : (
                            <Typography.Text className="mobile-parser-result-error" type="danger">
                              {result.error ?? '-'}
                            </Typography.Text>
                          )}
                          <Button
                            className="mobile-parser-result-view"
                            block
                            icon={<EyeOutlined />}
                            disabled={historyGate.blocked}
                            onClick={() => void viewMail(resultSession.accountId, result.uid)}
                          >
                            查看邮件原文
                          </Button>
                        </Card>
                      </div>
                    )}
                  />
                )}
              </div>
            )}

            {resultSession && !isMobile && (
              <Table<DryRunResult>
                rowKey="uid"
                dataSource={resultSession.results}
                size="small"
                pagination={{ pageSize: 10, current: resultPage, onChange: setResultPage }}
                columns={[
                  { title: 'UID', dataIndex: 'uid', width: 90 },
                  { title: '日期', dataIndex: 'date', width: 110, render: (v) => dayjs(v).format('MM-DD HH:mm') },
                  { title: '发件人', dataIndex: 'from', width: 200, ellipsis: true },
                  { title: '主题', dataIndex: 'subject', ellipsis: true },
                  {
                    title: '解析器',
                    dataIndex: 'parserId',
                    width: 90,
                    render: (v) => (v ? <Tag color="blue">{v}</Tag> : '-'),
                  },
                  {
                    title: '结果',
                    dataIndex: 'parsed',
                    width: 90,
                    render: (v) => (v ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>),
                  },
                  {
                    title: '解析出的账单 / 错误',
                    key: 'detail',
                    render: (_, r) =>
                      r.bills && r.bills.length > 0 ? (
                        <Space direction="vertical" size={0}>
                          {r.bills.map((b, i) => (
                            <span key={i}>
                              {b.bankName}（{b.cardLast4}）{b.period} 期 {formatMoney(b.amount, b.currency)}，还款日{' '}
                              {dayjs(b.dueDate).format('MM-DD')}
                              {b.holderName ? `，${b.holderName}` : ''}
                            </span>
                          ))}
                        </Space>
                      ) : (r.currentCycleTransactionCount ?? 0) > 0 ? (
                        <Typography.Text>未出账明细 {r.currentCycleTransactionCount} 笔</Typography.Text>
                      ) : (
                        <Typography.Text type="danger">{r.error ?? '-'}</Typography.Text>
                      ),
                  },
                  {
                    title: '原文',
                    key: 'view',
                    width: 80,
                    render: (_, r) => (
                      <Button
                        size="small"
                        icon={<EyeOutlined />}
                        disabled={historyGate.blocked}
                        onClick={() => void viewMail(resultSession.accountId, r.uid)}
                      >
                        查看
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </>
        )}
      </Card>

        </div>
      </MobilePullToRefresh>

      {!isMobile && <Modal
        title={viewBody ? `邮件原文 #${viewBody.uid}` : '邮件原文'}
        open={viewing !== null}
        onCancel={closeMail}
        footer={null}
        width={860}
      >
        {mailContent}
      </Modal>}
    </Page>
  );
}
