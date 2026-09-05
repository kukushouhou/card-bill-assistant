import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { ApiError } from '../../lib/errors';
import { assetReference, compileStyle, safePath } from './styles';
import { BUILTIN_IDS, VARIANTS, skinId, skinVersion, skinManifestSchema, type SkinDescriptor, type SkinManifest } from './manifest';

export const ZIP_LIMIT = 32 * 1024 * 1024;
export const EXPANDED_LIMIT = 128 * 1024 * 1024;
export const FILE_LIMIT = 512;
interface SkinPackage { manifest: SkinManifest; files: Map<string, Buffer>; hash: string }

function checkAsset(file: string, data: Buffer) {
  const ext = path.extname(file).toLowerCase();
  const signature = data.subarray(0, 16);
  let valid = false;
  if (ext === '.svg') {
    const svg = data.toString('utf8');
    const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'symbol', 'use', 'text', 'tspan']);
    valid = /<svg[\s>]/i.test(svg) && !/<[!?]|\bon\w+\s*=|\bstyle\s*=|&(?:#|[a-z]+;)|(?:href|src)\s*=\s*['"](?!#[\w-]+['"])/i.test(svg);
    for (const tag of svg.matchAll(/<\/?\s*([\w:-]+)/g)) if (!tags.has(tag[1].toLowerCase())) valid = false;
  } else if (ext === '.png') valid = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  else if (ext === '.jpg' || ext === '.jpeg') valid = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
  else if (ext === '.gif') valid = /^GIF8[79]a/.test(signature.toString('ascii'));
  else if (ext === '.webp') valid = signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
  else if (ext === '.avif') valid = signature.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(signature.toString('ascii', 8));
  else if (ext === '.woff') valid = signature.toString('ascii', 0, 4) === 'wOFF';
  else if (ext === '.woff2') valid = signature.toString('ascii', 0, 4) === 'wOF2';
  else if (ext === '.otf') valid = signature.toString('ascii', 0, 4) === 'OTTO';
  else if (ext === '.ttf') valid = signature.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]));
  if (!valid) throw new ApiError(400, '皮肤资源损坏或格式不支持：' + file);
}

export function validatePackage(files: Map<string, Buffer>): SkinPackage {
  if (!files.has('skin.json')) throw new ApiError(400, '皮肤包根目录缺少 skin.json');
  if (files.get('skin.json')!.length > 1024 * 1024) throw new ApiError(400, '皮肤描述文件过大');
  let input: unknown;
  try { input = JSON.parse(files.get('skin.json')!.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new ApiError(400, '皮肤描述无法读取'); }
  const result = skinManifestSchema.safeParse(input);
  if (!result.success) throw new ApiError(400, '皮肤格式或兼容版本不正确：' + result.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).slice(0, 4).join('；'));
  const manifest = result.data;
  const styles = new Set([...manifest.styles, ...VARIANTS.flatMap(variant => manifest.variants[variant].styles)]);
  const assets = new Set(manifest.assets);
  const declared = new Set(['skin.json', ...styles, ...assets, ...manifest.licenses]);
  let size = 0;
  for (const [file, content] of files) {
    safePath(file); size += content.length;
    if (!declared.has(file)) throw new ApiError(400, '皮肤文件未声明：' + file);
    if (styles.has(file)) {
      if (!file.endsWith('.css')) throw new ApiError(400, '皮肤样式必须是 CSS 文件');
      compileStyle(content.toString('utf8'), file, files, '[data-skin="' + manifest.id + '@' + manifest.version + '"]', '/api/skins/assets/' + manifest.id + '/' + manifest.version + '/');
    } else if (manifest.licenses.includes(file)) {
      if (!file.endsWith('.txt') || content.length > 65536 || !Buffer.from(content.toString('utf8')).equals(content)) throw new ApiError(400, '许可文件必须是 UTF-8 文本');
    } else if (file !== 'skin.json') checkAsset(file, content);
  }
  if (files.size > FILE_LIMIT || size > EXPANDED_LIMIT) throw new ApiError(400, '皮肤包超过容量限制');
  for (const file of declared) if (!files.has(safePath(file))) throw new ApiError(400, '皮肤资源缺失：' + file);
  for (const variant of VARIANTS) {
    const def = manifest.variants[variant];
    for (const resource of [manifest.previews[variant], ...Object.values(def.icons), ...Object.values(def.decorations)]) {
      const ref = assetReference(resource, 'skin.json', files);
      if (!assets.has(ref) || !/\.(png|jpe?g|webp|svg|avif|gif)$/i.test(ref)) throw new ApiError(400, '皮肤图片资源无效：' + resource);
    }
  }
  const hash = createHash('sha256');
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update('\0').update(String(content.length)).update('\0').update(content);
  return { manifest, files, hash: hash.digest('hex') };
}

export async function readSkinZip(buffer: Buffer): Promise<SkinPackage> {
  if (buffer.length > ZIP_LIMIT) throw new ApiError(413, '皮肤包不能超过 32 MiB');
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  let total = 0; let count = 0;
  try {
    const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    try {
      for await (const entry of zip.eachEntry()) {
        if (++count > FILE_LIMIT) throw new ApiError(400, '皮肤包最多包含 512 个文件');
        const directory = entry.fileName.endsWith('/');
        const name = safePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
        if (seen.has(name.toLowerCase())) throw new ApiError(400, '皮肤包包含重复文件');
        seen.add(name.toLowerCase());
        const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) throw new ApiError(400, '皮肤包不能包含链接或特殊文件');
        if ((entry.generalPurposeBitFlag & 1) || entry.uncompressedSize > EXPANDED_LIMIT - total) throw new ApiError(400, '皮肤包超出容量限制或已加密');
        if (directory) continue;
        const chunks: Buffer[] = [];
        const stream = await zip.openReadStreamPromise(entry);
        for await (const chunk of stream) {
          const data = Buffer.from(chunk); total += data.length;
          if (total > EXPANDED_LIMIT) { stream.destroy(); throw new ApiError(400, '皮肤解压后超过 128 MiB'); }
          chunks.push(data);
        }
        files.set(name, Buffer.concat(chunks));
      }
    } finally { zip.close(); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, '无法读取皮肤 ZIP 包，请检查文件是否完整');
  }
  return validatePackage(files);
}

async function readDirectory(root: string): Promise<SkinPackage> {
  const files = new Map<string, Buffer>(); let size = 0;
  async function read(relative: string) {
    const directory = path.join(root, relative);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw new ApiError(400, '皮肤目录不能使用链接');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      safePath(name);
      if (entry.isDirectory()) await read(name);
      else if (entry.isFile()) {
        const file = path.join(root, name); const info = await fs.stat(file);
        size += info.size;
        if (size > EXPANDED_LIMIT || files.size >= FILE_LIMIT) throw new ApiError(400, '皮肤文件超过容量限制');
        files.set(name, await fs.readFile(file));
      } else throw new ApiError(400, '皮肤包含特殊文件');
    }
  }
  await read('');
  return validatePackage(files);
}

export class SkinStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly customRoot: string, readonly builtinRoot: string) {}

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  directory(id: string, version: string) {
    skinId.parse(id); skinVersion.parse(version);
    return path.resolve(BUILTIN_IDS.has(id) ? this.builtinRoot : this.customRoot, id, version);
  }
  async read(id: string, version: string): Promise<SkinPackage> {
    try {
      const result = await readDirectory(this.directory(id, version));
      if (result.manifest.id !== id || result.manifest.version !== version) throw new ApiError(400, '皮肤目录与描述不一致');
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, '皮肤或资源不存在');
      throw error;
    }
  }
  async readManifest(id: string, version: string): Promise<SkinManifest> {
    const filename = path.join(this.directory(id, version), 'skin.json');
    try {
      if ((await fs.stat(filename)).size > 1024 * 1024) throw new ApiError(400, '皮肤描述文件过大');
      const manifest = skinManifestSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
      if (manifest.id !== id || manifest.version !== version) throw new ApiError(400, '皮肤目录与描述不一致');
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, '皮肤不存在');
      throw error;
    }
  }
  descriptor(pack: SkinPackage): SkinDescriptor {
    return { manifest: pack.manifest, hash: pack.hash, builtin: BUILTIN_IDS.has(pack.manifest.id), baseUrl: '/api/skins/assets/' + pack.manifest.id + '/' + pack.manifest.version + '/' };
  }
  async list(): Promise<SkinDescriptor[]> {
    const items: SkinDescriptor[] = [];
    for (const root of [this.builtinRoot, this.customRoot]) {
      const directories = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const directory of directories) {
        if (!directory.isDirectory() || !skinId.safeParse(directory.name).success || (root === this.customRoot && BUILTIN_IDS.has(directory.name))) continue;
        for (const version of await fs.readdir(path.join(root, directory.name))) {
          if (!skinVersion.safeParse(version).success) continue;
          try { items.push(this.descriptor(await this.read(directory.name, version))); }
          catch {
            // 已安装包后来丢失资源时仍可在管理页删除，不能成为不可管理的隐藏目录。
            try {
              const manifest = await this.readManifest(directory.name, version);
              items.push({ manifest, builtin: root === this.builtinRoot, hash: '', available: false, baseUrl: '/api/skins/assets/' + manifest.id + '/' + version + '/' });
            } catch { /* 无法识别的目录不属于可安装皮肤。 */ }
          }
        }
      }
    }
    return items;
  }
  async install(buffer: Buffer) {
    const pack = await readSkinZip(buffer);
    return this.exclusive(async () => {
      const { id, version } = pack.manifest;
      let existing: SkinPackage | undefined;
      try { existing = await this.read(id, version); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      if (existing?.hash === pack.hash) return { skin: this.descriptor(existing), exists: true };
      if (BUILTIN_IDS.has(id)) throw new ApiError(409, '内置皮肤不能被覆盖，请使用新的皮肤标识');
      if (existing) throw new ApiError(409, '该版本已存在不同内容，请更新皮肤版本号后重新导入');
      await fs.mkdir(this.customRoot, { recursive: true });
      const staging = path.join(this.customRoot, '.staging-' + randomUUID());
      await fs.mkdir(staging);
      try {
        for (const [name, data] of pack.files) {
          const target = path.join(staging, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data, { flag: 'wx' });
        }
        const destination = this.directory(id, version);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Windows 索引或杀毒软件可能短暂占用刚写完的资源，保留原子换目录并有限退避。
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(staging, destination); break; }
          catch (error) {
            if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            await delay(100 * (attempt + 1));
          }
        }
      } finally { await fs.rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
      return { skin: this.descriptor(pack), exists: false };
    });
  }
  async export(id: string, version: string): Promise<Buffer> {
    const pack = await this.read(id, version); const zip = new yazl.ZipFile(); const chunks: Buffer[] = [];
    const output = new Promise<Buffer>((resolve, reject) => {
      zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      zip.outputStream.on('error', reject); zip.on('error', reject);
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    for (const [name, content] of pack.files) zip.addBuffer(content, name);
    zip.end(); return output;
  }
  async removeFiles(id: string, version: string) {
    if (BUILTIN_IDS.has(id)) throw new ApiError(400, '内置皮肤不能删除');
    const target = this.directory(id, version);
    const root = path.resolve(this.customRoot) + path.sep;
    if (!target.startsWith(root)) throw new ApiError(400, '皮肤路径无效');
    await fs.rm(target, { recursive: true, force: true });
  }
}
