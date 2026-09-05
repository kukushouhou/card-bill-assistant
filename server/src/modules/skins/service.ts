import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { APPLIED_SKIN_KEY, BUILTIN_IDS, DEFAULT_SKIN } from './manifest';
import { SkinStore } from './store';

export const skins = new SkinStore(config.skinStorageDir, config.builtinSkinDir);

export async function activeSkin() {
  let selected = DEFAULT_SKIN;
  try {
    const stored = await prisma.appSetting.findUnique({ where: { key: APPLIED_SKIN_KEY } });
    if (stored) selected = JSON.parse(stored.value);
    return skins.descriptor(await skins.read(selected.id, selected.version));
  } catch {
    return skins.descriptor(await skins.read(DEFAULT_SKIN.id, DEFAULT_SKIN.version));
  }
}

export async function applySkin(id: string, version: string) {
  return skins.exclusive(async () => {
    const descriptor = skins.descriptor(await skins.read(id, version));
    await prisma.appSetting.upsert({ where: { key: APPLIED_SKIN_KEY }, create: { key: APPLIED_SKIN_KEY, value: JSON.stringify({ id, version }) }, update: { value: JSON.stringify({ id, version }) } });
    return descriptor;
  });
}

export async function deleteSkin(id: string, version: string, restoreDefault: boolean) {
  return skins.exclusive(async () => {
    if (BUILTIN_IDS.has(id)) throw new ApiError(400, '内置皮肤不能删除');
    await skins.readManifest(id, version);
    const stored = await prisma.appSetting.findUnique({ where: { key: APPLIED_SKIN_KEY } });
    let selected = DEFAULT_SKIN;
    try { if (stored) selected = JSON.parse(stored.value); } catch { /* 损坏选择视作默认。 */ }
    const isActive = selected.id === id && selected.version === version;
    if (isActive && !restoreDefault) throw new ApiError(409, '此皮肤正在使用，请选择恢复默认并删除');
    if (isActive) {
      await skins.read(DEFAULT_SKIN.id, DEFAULT_SKIN.version);
      await prisma.appSetting.upsert({ where: { key: APPLIED_SKIN_KEY }, create: { key: APPLIED_SKIN_KEY, value: JSON.stringify(DEFAULT_SKIN) }, update: { value: JSON.stringify(DEFAULT_SKIN) } });
    }
    await skins.removeFiles(id, version);
    return activeSkin();
  });
}
