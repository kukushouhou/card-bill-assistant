/** 从已发布的包格式制作独立示例，验证不依赖重新构建应用。 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as yazl from 'yazl';
import { SkinStore, validatePackage } from '../src/modules/skins/store';
import { VARIANTS } from '../src/modules/skins/manifest';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(serverRoot, '../docs/skins/examples/graphite-notebook.zip'));
const store = new SkinStore(path.join(serverRoot, 'data/skins'), path.join(serverRoot, 'skins'));
const pack = await store.read('warm-ledger', '1.0.0');
pack.manifest.id = 'graphite-notebook'; pack.manifest.name = '石墨账本示例'; pack.manifest.author = '守候';
pack.manifest.description = '独立皮肤包示例：方正组件、衬线数字、自带字体、线纹背景与替换图标。';
for (const variant of VARIANTS) {
  const definition = pack.manifest.variants[variant];
  definition.tokens.fontFamily = '"Skin Lora", "Microsoft YaHei", sans-serif';
  definition.tokens.radius = 4;
  definition.icons.CreditCardOutlined = 'assets/ledger.svg';
  definition.decorations.header = 'assets/paper.svg';
}
pack.files.set('assets/paper.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M0 16H64M0 32H64M0 48H64" stroke="#899087" stroke-opacity="0.12"/></svg>'));
pack.files.set('styles/base.css', Buffer.from(pack.files.get('styles/base.css')!.toString('utf8') + '\n.ant-btn { border-radius: 3px; font-weight: 600; }\n.agenda-mobile-row { border-radius: 4px; border-left: 3px solid var(--primary); }\n.ant-card { border-radius: 4px; }\n'));
pack.files.set('skin.json', Buffer.from(JSON.stringify(pack.manifest, null, 2)));
validatePackage(pack.files);
await fs.mkdir(path.dirname(output), { recursive: true });
const zip = new yazl.ZipFile();
const chunks: Buffer[] = [];
const done = new Promise<void>((resolve, reject) => {
  zip.outputStream.on('data', chunk => chunks.push(chunk));
  zip.outputStream.on('error', reject);
  zip.outputStream.on('end', () => fs.writeFile(output, Buffer.concat(chunks)).then(() => resolve(), reject));
});
for (const [name, content] of pack.files) zip.addBuffer(content, name);
zip.end(); await done;
console.log('示例皮肤包已生成：' + output);
