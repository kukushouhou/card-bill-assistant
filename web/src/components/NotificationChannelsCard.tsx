import { useRef, useState } from 'react';
import { Alert, App, Button, Card, Empty, Popconfirm, Skeleton, Table } from 'antd';
import type { NotificationChannelInfo, SettingsInfo } from '../api/types';
import { api } from '../api/client';
import { BellOutlined, PlusOutlined } from '../skins/icons';
import { useResponsive } from '../responsive';
import SettingSwitch from './SettingSwitch';
import { InlineConfirm } from './MobilePrimitives';
import './notification-channels.css';

type Refresh = (options?: { freshAfterInFlight?: boolean }) => Promise<void>;

export default function NotificationChannelsCard({ settings, reading, readError, onRetry, beginWrite, endWrite, refreshSettings, onEdit }: {
  settings: SettingsInfo | null; reading: boolean; readError: string | null; onRetry: Refresh;
  beginWrite: () => boolean; endWrite: () => void; refreshSettings: Refresh;
  onEdit: (channel: NotificationChannelInfo | null) => void;
}) {
  const { message } = App.useApp();
  const { isMobile } = useResponsive();
  const [deleting, setDeleting] = useState<number | null>(null);
  const [busy, setBusy] = useState<Record<number, string>>({});
  const locks = useRef(new Set<number>());
  const providers = settings?.notifications.providers ?? [];
  const channels = settings?.notifications.channels ?? [];
  const providerName = (type: string) => providers.find(item => item.type === type)?.name ?? type;
  const reload = async () => {
    await refreshSettings({ freshAfterInFlight: true }).catch(() => message.warning('操作已完成，列表刷新失败，请重试'));
  };
  const action = async (channel: NotificationChannelInfo, operation: 'test' | 'toggle' | 'delete') => {
    if (locks.current.has(channel.id)) return;
    const writing = operation !== 'test';
    if (writing && !beginWrite()) return;
    locks.current.add(channel.id); setBusy(current => ({ ...current, [channel.id]: operation }));
    try {
      const url = '/api/settings/notification-channels/' + channel.id;
      if (operation === 'test') { await api.post(url + '/test'); message.success('测试通知已发送'); }
      if (operation === 'toggle') await api.put(url, { enabled: !channel.enabled });
      if (operation === 'delete') { await api.delete(url); setDeleting(null); message.success('已删除'); }
    } catch (error) { message.error(error instanceof Error ? error.message : '操作失败，请重试'); }
    finally { if (writing) endWrite(); }
    if (writing) await reload();
    locks.current.delete(channel.id);
    setBusy(current => { const next = { ...current }; delete next[channel.id]; return next; });
  };
  const status = (channel: NotificationChannelInfo) => <div className="notification-channel-status">
    <span>{channel.enabled ? '已启用' : '已停用'}</span>
    <SettingSwitch aria-label={'启用 ' + channel.name} checked={channel.enabled} loading={busy[channel.id] === 'toggle'}
      disabled={Boolean(readError || busy[channel.id])} onChange={() => void action(channel, 'toggle')} />
  </div>;
  const actions = (channel: NotificationChannelInfo) => <div className="notification-channel-actions">
    <Button size={isMobile ? 'middle' : 'small'} disabled={Boolean(readError || busy[channel.id])} loading={busy[channel.id] === 'test'} onClick={() => void action(channel, 'test')}>测试</Button>
    <Button size={isMobile ? 'middle' : 'small'} disabled={Boolean(readError || busy[channel.id])} onClick={() => onEdit(channel)}>编辑</Button>
    {isMobile ? <Button danger disabled={Boolean(readError || busy[channel.id])} onClick={() => setDeleting(channel.id)}>删除</Button> :
      <Popconfirm title={'删除“' + channel.name + '”？'} description="删除后此渠道将不再接收提醒。" okText="删除" cancelText="取消"
        onConfirm={() => action(channel, 'delete')} okButtonProps={{ danger: true }}>
        <Button size="small" danger disabled={Boolean(readError || busy[channel.id])} loading={busy[channel.id] === 'delete'}>删除</Button>
      </Popconfirm>}
  </div>;
  const name = (channel: NotificationChannelInfo) => <><div className="notification-channel-name">{channel.name}</div>{channel.configError && <div className="notification-channel-error">{channel.configError}</div>}</>;
  return <>
    <Card className="settings-card notification-channel-list" title={<span className="notification-channel-heading"><BellOutlined />通知渠道</span>}
      extra={<Button aria-label="添加渠道" type="primary" icon={<PlusOutlined />} disabled={!settings || Boolean(readError)} onClick={() => onEdit(null)}>添加渠道</Button>}>
      {readError && <Alert type="error" title="通知渠道读取失败" description={readError}
        action={<Button loading={reading} onClick={() => void onRetry().catch(() => undefined)}>重试</Button>} />}
      {!settings ? !readError && <Skeleton active /> : channels.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未添加通知渠道" /> :
        isMobile ? <div className="notification-channel-cards">{channels.map(channel => <article className="notification-channel-card" key={channel.id} aria-label={channel.name}>
          <div className="notification-channel-card-header"><div>{name(channel)}<div className="notification-channel-type">{providerName(channel.type)}</div></div>{status(channel)}</div>
          {actions(channel)}
          {deleting === channel.id && <InlineConfirm title={'删除“' + channel.name + '”？'} description="删除后此渠道将不再接收提醒。" confirmText="删除"
            loading={busy[channel.id] === 'delete'} onCancel={() => setDeleting(null)} onConfirm={() => void action(channel, 'delete')} />}
        </article>)}</div> :
        <Table<NotificationChannelInfo> rowKey="id" dataSource={channels} pagination={false} size="middle"
          columns={[
            { title: '名称', key: 'name', render: (_, channel) => name(channel) },
            { title: '渠道类型', dataIndex: 'type', width: 150, render: providerName },
            { title: '启用', key: 'enabled', width: 155, render: (_, channel) => status(channel) },
            { title: '操作', key: 'actions', width: 200, render: (_, channel) => actions(channel) },
          ]} />}
    </Card>
  </>;
}
