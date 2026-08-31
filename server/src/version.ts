import fs from 'node:fs';

interface PackageMeta {
  version?: unknown;
}

function readVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const value = (JSON.parse(raw) as PackageMeta).version;
    return typeof value === 'string' && value.trim() ? value.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();
