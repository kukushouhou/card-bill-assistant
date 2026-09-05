import express, { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from './middleware';
import { activeSkin, applySkin, deleteSkin, skins } from '../modules/skins/service';
import { skinId, skinVersion } from '../modules/skins/manifest';
import { compileStyle, safePath } from '../modules/skins/styles';
import { ZIP_LIMIT } from '../modules/skins/store';

const router = Router();
const selection = z.object({ id: skinId, version: skinVersion });
router.get('/active', asyncHandler(async (_req, res) => { res.set('Cache-Control', 'no-store').json(await activeSkin()); }));
router.get('/builtins', asyncHandler(async (_req, res) => { res.json((await skins.list()).filter(skin => skin.builtin)); }));
router.get('/assets/:id/:version/*asset', asyncHandler(async (req, res) => {
  const { id, version } = selection.parse(req.params);
  const asset = safePath((req.params.asset as unknown as string[]).join('/'));
  const pack = await skins.read(id, version);
  const content = pack.files.get(asset);
  if (!content || asset === 'skin.json') throw new ApiError(404, '皮肤资源不存在');
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'none'; sandbox" });
  if (asset.endsWith('.css')) {
    res.type('text/css').send(compileStyle(content.toString('utf8'), asset, pack.files, '[data-skin="' + id + '@' + version + '"]', '/api/skins/assets/' + id + '/' + version + '/'));
  } else res.type(asset.split('.').at(-1)!).send(content);
}));

router.use(requireAuth);
router.get('/', asyncHandler(async (_req, res) => { res.json({ items: await skins.list(), active: await activeSkin() }); }));
router.post('/import', express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: ZIP_LIMIT }), asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(400, '请选择 ZIP 皮肤包');
  res.json(await skins.install(req.body));
}));
router.put('/active', asyncHandler(async (req, res) => {
  const { id, version } = selection.parse(req.body); res.json(await applySkin(id, version));
}));
router.get('/:id/:version/export', asyncHandler(async (req, res) => {
  const { id, version } = selection.parse(req.params);
  res.attachment(id + '-' + version + '.zip').type('application/zip').send(await skins.export(id, version));
}));
router.delete('/:id/:version', asyncHandler(async (req, res) => {
  const { id, version } = selection.parse(req.params);
  const { restoreDefault = false } = z.object({ restoreDefault: z.boolean().optional() }).parse(req.body ?? {});
  res.json(await deleteSkin(id, version, restoreDefault));
}));
export default router;
