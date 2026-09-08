import fs from 'node:fs';

interface PackageMeta {
  version?: unknown;
}

function readVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const value = (JSON.parse(raw) as PackageMeta).version;
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.trim())) throw new Error('版本号无效');
    return value.trim();
  } catch {
    // 版本游标依赖真实包版本，不能猜测一个值继续执行迁移。
    throw new Error('无法读取有效的应用版本，请检查后端安装包');
  }
}

export const APP_VERSION = readVersion();
