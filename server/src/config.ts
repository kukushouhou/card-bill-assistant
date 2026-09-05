import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 应用名默认值：未设置 APP_NAME 环境变量时全局使用 */
export const DEFAULT_APP_NAME = '守候信用卡小管家';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少必需的环境变量: ${name}`);
  return v;
}

export const config = {
  /** 应用显示名（登录页/导航栏/页面标题/通知标题），环境变量 APP_NAME 可自定义 */
  get appName(): string {
    return process.env.APP_NAME?.trim() || DEFAULT_APP_NAME;
  },
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get encryptionKey(): Buffer {
    const hex = required('ENCRYPTION_KEY');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('ENCRYPTION_KEY 必须是 32 字节的 hex 字符串（64 个字符）');
    }
    return Buffer.from(hex, 'hex');
  },
  get jwtSecret(): string {
    return required('JWT_SECRET');
  },
  /** HTTPS 部署保持 true；仅明确使用局域网 HTTP 时设为 false。 */
  get cookieSecure(): boolean {
    const raw = process.env.COOKIE_SECURE?.trim().toLowerCase();
    if (!raw) return process.env.NODE_ENV === 'production';
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new Error('COOKIE_SECURE 必须是 true 或 false');
  },
  get port(): number {
    return Number(process.env.PORT || 3000);
  },
  get reminderHour(): number {
    const h = Number(process.env.REMINDER_HOUR ?? 8);
    return h >= 0 && h <= 23 ? h : 8;
  },
  get webDistDir(): string {
    return process.env.WEB_DIST_DIR || path.resolve(here, '../../web/dist');
  },
  /** 皮肤资源独立持久化；Docker 映射到 /app/data/skins。 */
  get skinStorageDir(): string {
    return path.resolve(process.env.SKIN_STORAGE_DIR || path.resolve(here, '../data/skins'));
  },
  get builtinSkinDir(): string {
    return path.resolve(here, '../skins');
  },
};
