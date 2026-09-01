export interface NotificationMessage {
  title: string;
  body: string;
}

export interface NotificationSendResult {
  ok: boolean;
  error?: string;
}

export interface NotificationProviderField {
  key: string;
  label: string;
  type: 'url' | 'text' | 'password' | 'select';
  placeholder?: string;
  description?: string;
  required: boolean;
  advanced?: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface NotificationProviderDefinition {
  type: string;
  name: string;
  description: string;
  fields: NotificationProviderField[];
  configMode?: 'fields' | 'custom-http';
}

export type NotificationChannelConfig = Record<string, unknown>;

/**
 * 通知提供方插件契约。新增渠道只需实现该接口并注册，无需改设置路由或调度器。
 */
export interface NotificationProvider {
  definition: NotificationProviderDefinition;
  parseConfig(input: unknown): NotificationChannelConfig;
  sendBatch(
    config: NotificationChannelConfig,
    messages: NotificationMessage[],
    group?: string,
  ): Promise<NotificationSendResult>;
}

export interface ResolvedNotificationChannel {
  type: string;
  name: string;
  enabled: boolean;
  config: NotificationChannelConfig;
}
