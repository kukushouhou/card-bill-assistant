import { App, Form } from 'antd';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { NotificationProviderDefinition } from '../api/types';
import { NotificationConfigFields } from './NotificationConfigFields';

const barkProvider: NotificationProviderDefinition = {
  type: 'bark',
  name: 'Bark',
  description: 'Bark 通知',
  fields: [
    { key: 'url', label: '推送地址', type: 'url', required: true },
    { key: 'group', label: '推送分组', type: 'text', required: false, advanced: true },
    { key: 'sound', label: '通知铃声', type: 'text', required: false, advanced: true },
    {
      key: 'level',
      label: '通知级别',
      type: 'select',
      required: false,
      advanced: true,
      options: [{ value: 'timeSensitive', label: '时效性通知' }],
    },
    { key: 'icon', label: '通知图标', type: 'url', required: false, advanced: true },
  ],
};

describe('通知渠道配置字段', () => {
  it('默认只显示基础项，展开高级设置后显示 Bark 扩展项', async () => {
    const user = userEvent.setup();
    render(
      <App>
        <Form>
          <NotificationConfigFields provider={barkProvider} prefix={['config']} />
        </Form>
      </App>,
    );

    expect(screen.getByLabelText('推送地址')).not.toBeNull();
    expect(screen.queryByLabelText('推送分组')).toBeNull();

    await user.click(screen.getByText('高级设置'));

    expect(await screen.findByLabelText('推送分组')).not.toBeNull();
    expect(screen.getByLabelText('通知铃声')).not.toBeNull();
    expect(screen.getByLabelText('通知级别')).not.toBeNull();
    expect(screen.getByLabelText('通知图标')).not.toBeNull();
  });
});
