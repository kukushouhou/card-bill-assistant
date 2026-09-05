import { useRef, useState } from 'react';
import { Alert, App, Button, Skeleton } from 'antd';
import { api } from '../api/client';
import type { CustomReminder, CustomReminderInput } from '../api/types';
import { useResource } from '../lib/useResource';
import { CustomForm, CustomReminderManager } from '../pages/Reminders';
import BusinessFlow from './BusinessFlow';

export default function ReminderSettings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { message } = App.useApp();
  const { data, error, refresh } = useResource<CustomReminder[]>('/api/reminders/custom');
  const [editing, setEditing] = useState<CustomReminder | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<CustomReminder | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const lock = useRef(false);
  const submit = async (values: CustomReminderInput) => {
    if (lock.current) return;
    lock.current = true; setSaving(true);
    try {
      if (editing) await api.put('/api/reminders/custom/' + editing.id, values);
      else await api.post('/api/reminders/custom', values);
      message.success('已保存'); setEditing(undefined); void refresh(); onChanged();
    } catch (e) { message.error(e instanceof Error ? e.message : '保存失败'); }
    finally { lock.current = false; setSaving(false); }
  };
  const remove = async (item: CustomReminder) => {
    if (lock.current) return;
    lock.current = true; setDeleting(true);
    try { await api.delete('/api/reminders/custom/' + item.id); setDeleteTarget(null); message.success('已删除'); void refresh(); onChanged(); }
    catch (e) { message.error(e instanceof Error ? e.message : '删除失败'); }
    finally { lock.current = false; setDeleting(false); }
  };
  return <>
    {!data ? <BusinessFlow title="提醒设置" onClose={onClose}>{error ? <Alert type="error" title={error} action={<Button onClick={() => void refresh()}>重试</Button>} /> : <Skeleton active />}</BusinessFlow> : <CustomReminderManager open items={data} deleteTarget={deleteTarget} deleting={deleting} onClose={onClose}
      onCreate={() => setEditing(null)} onEdit={setEditing} onDelete={item => void remove(item)} onDeleteStart={setDeleteTarget} onDeleteCancel={() => setDeleteTarget(null)} onDeleteConfirm={() => { if (deleteTarget) void remove(deleteTarget); }} />}
    {editing !== undefined && <CustomForm initial={editing} confirmLoading={saving} onCancel={() => setEditing(undefined)} onOk={values => void submit(values)} />}
  </>;
}
