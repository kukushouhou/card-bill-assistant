import { z } from 'zod';

export const SKIN_API = 1;
export const VARIANTS = ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'] as const;
export const skinId = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, '皮肤标识格式不正确');
export const skinVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.-]{1,32})?$/, '皮肤版本格式不正确');
const filePath = z.string().min(1).max(180);
const color = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, '颜色须使用十六进制格式');
const visualTokens = z.object({
  primary: color, primarySoft: color, background: color, surface: color, elevated: color,
  text: color, textSecondary: color, border: color, danger: color, success: color, warning: color,
  fontFamily: z.string().min(1).max(200).regex(/^[^;{}<>\\]+$/),
  fontSize: z.number().min(14).max(20), radius: z.number().min(0).max(32),
  controlHeight: z.number().min(36).max(56),
  chartColors: z.array(color).min(2).max(12),
  chart: z.object({
    lineWidth: z.number().min(1).max(6), pointSize: z.number().min(0).max(8),
    gridWidth: z.number().min(0).max(3), axisFontSize: z.number().min(11).max(16),
  }).strict().optional(),
}).strict();
const icons = z.record(z.string().regex(/^[A-Z][A-Za-z0-9]{1,63}$/), filePath);
const decorations = z.object({ background: filePath.optional(), header: filePath.optional(), sidebar: filePath.optional(), content: filePath.optional(), footer: filePath.optional() }).strict();
const variant = z.object({
  styles: z.array(filePath).min(1).max(12), tokens: visualTokens,
  icons: icons.default({}), decorations: decorations.default({}),
}).strict();
export const skinManifestSchema = z.object({
  formatVersion: z.literal(1), id: skinId, version: skinVersion,
  name: z.string().trim().min(1).max(48), description: z.string().max(240).optional(), author: z.string().max(80).optional(),
  compatibility: z.object({ skinApi: z.literal(SKIN_API) }).strict(),
  styles: z.array(filePath).max(12).default([]),
  assets: z.array(filePath).max(500),
  licenses: z.array(filePath).max(20).default([]),
  variants: z.object({ 'desktop-light': variant, 'desktop-dark': variant, 'mobile-light': variant, 'mobile-dark': variant }).strict(),
  previews: z.object({ 'desktop-light': filePath, 'desktop-dark': filePath, 'mobile-light': filePath, 'mobile-dark': filePath }).strict(),
}).strict();

export type SkinManifest = z.infer<typeof skinManifestSchema>;
export type SkinVariant = typeof VARIANTS[number];
export interface SkinDescriptor { manifest: SkinManifest; builtin: boolean; hash: string; baseUrl: string; available?: boolean }
export const DEFAULT_SKIN = { id: 'modern', version: '1.0.0' };
export const BUILTIN_IDS = new Set(['modern', 'warm-ledger']);
export const APPLIED_SKIN_KEY = 'appearance.skin';
