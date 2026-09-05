import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as yazl from 'yazl';
import { SkinStore, readSkinZip, validatePackage, ZIP_LIMIT } from '../src/modules/skins/store';
import { compileStyle } from '../src/modules/skins/styles';

let directory: string;
let store: SkinStore;
async function zip(files: Map<string, Buffer>) {
  const archive = new yazl.ZipFile(); const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => { archive.outputStream.on('data', chunk => chunks.push(chunk)); archive.outputStream.on('end', () => resolve(Buffer.concat(chunks))); archive.outputStream.on('error', reject); });
  for (const [name, content] of files) archive.addBuffer(content, name);
  archive.end(); return result;
}
async function example(version = '1.0.0') {
  const pack = await readSkinZip(await store.export('warm-ledger', '1.0.0'));
  pack.manifest.id = 'test-notebook'; pack.manifest.name = '测试账本'; pack.manifest.version = version;
  pack.files.set('skin.json', Buffer.from(JSON.stringify(pack.manifest)));
  return pack.files;
}
beforeEach(async () => {
  const tempRoot = path.resolve('tests/.skin-tmp'); await fs.mkdir(tempRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(tempRoot, 'case-'));
  store = new SkinStore(directory, path.resolve('skins'));
});
afterEach(async () => {
  const tempRoot = path.resolve('tests/.skin-tmp') + path.sep;
  if (!path.resolve(directory).startsWith(tempRoot)) throw new Error('测试目录越界');
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rmdir(path.resolve('tests/.skin-tmp')).catch(() => undefined);
});

describe('完整皮肤包', () => {
  it('两套内置包和四种效果均可校验，导出后可重复导入', async () => {
    expect((await store.list()).map(item => item.manifest.name).sort()).toEqual(['克制现代', '温润账本'].sort());
    const bytes = await store.export('modern', '1.0.0');
    expect((await store.install(bytes)).exists).toBe(true);
    expect(Object.keys((await readSkinZip(bytes)).manifest.variants)).toHaveLength(4);
  });
  it('独立测试皮肤包含背景、实际字体、图标和组件样式，重启存储对象后仍可导出重导入', async () => {
    const files = await example(); const pack = await store.install(await zip(files));
    expect(pack.exists).toBe(false);
    expect(pack.skin.manifest.variants['mobile-dark'].decorations.background).toBeDefined();
    expect(files.has('assets/Lora.ttf')).toBe(true);
    expect(pack.skin.manifest.variants['desktop-light'].icons.ProfileOutlined).toBeDefined();
    const restarted = new SkinStore(directory, path.resolve('skins'));
    const exported = await restarted.export('test-notebook', '1.0.0');
    expect((await restarted.install(exported)).exists).toBe(true);
    expect((await readSkinZip(exported)).hash).toBe(pack.skin.hash);
  });
  it('同版本不同内容不覆盖；不同版本独立保留；内置标识受保护', async () => {
    const files = await example(); await store.install(await zip(files));
    files.set('styles/base.css', Buffer.from('.ant-btn { border-radius: 2px; }'));
    await expect(store.install(await zip(files))).rejects.toThrow('版本号');
    await store.install(await zip(await example('1.1.0')));
    expect((await store.list()).filter(item => !item.builtin)).toHaveLength(2);
    await expect(store.removeFiles('modern', '1.0.0')).rejects.toThrow('内置');
  });
  it('损坏的新版本校验失败，不写入目录且原版本可用', async () => {
    await store.install(await zip(await example()));
    const damaged = await example('1.1.0'); damaged.set('assets/Lora.ttf', Buffer.from('broken'));
    await expect(store.install(await zip(damaged))).rejects.toThrow('资源损坏');
    expect((await store.read('test-notebook', '1.0.0')).manifest.version).toBe('1.0.0');
    await expect(store.read('test-notebook', '1.1.0')).rejects.toThrow('不存在');
    expect((await fs.readdir(directory)).some(name => name.startsWith('.staging'))).toBe(false);
  });
  it('拒绝脚本、外部 URL、越界引用、缺失资源和过大的压缩包', async () => {
    const files = await example();
    const run = (css: string) => compileStyle(css, 'styles/base.css', files, '[data-skin="test"]', '/assets/');
    expect(() => run('.ant-btn { background: url(https://example.com/a.png) }')).toThrow();
    expect(() => run('@import "other.css";')).toThrow();
    expect(() => run('.ant-btn { background: url(../../secrets.png) }')).toThrow();
    expect(() => run('input[value="a"] { color: red }')).toThrow();
    expect(() => run('.ant-btn { display: none }')).toThrow();
    expect(run('.ant-btn { background: url(../assets/paper.svg); border-radius: 2px }')).toContain('/assets/assets/paper.svg');
    const broken = new Map(files); broken.set('assets/ledger.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect(() => validatePackage(broken)).toThrow();
    broken.delete('assets/ledger.svg'); expect(() => validatePackage(broken)).toThrow('缺失');
    await expect(readSkinZip(Buffer.alloc(ZIP_LIMIT + 1))).rejects.toThrow('32 MiB');
  });
});
