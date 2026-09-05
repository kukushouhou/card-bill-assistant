import './skins.css';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { App as AntApp, ConfigProvider, Segmented } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { api } from '../api/client';
import { SkinAssetsContext } from './SkinAssets';
import modern from '../../../server/skins/modern/1.0.0/skin.json';
import { prepareSkin, setSkinVariables, skinTheme } from './runtime';
import type { ColorMode, SkinDescriptor, SkinManifest, SkinVariant } from './types';

const fallback: SkinDescriptor = { manifest: modern as SkinManifest, builtin: true, hash: 'builtin-modern', baseUrl: '/api/skins/assets/modern/1.0.0/' };
const MODE_KEY = 'appearance.mode';
const CACHE_KEY = 'appearance.skin-cache';
function initialSkin() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as SkinDescriptor | null;
    if (cached?.manifest?.compatibility?.skinApi === 1
      && /^[a-z][a-z0-9-]{1,47}$/.test(cached.manifest.id)
      && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(cached.manifest.version)
      && Array.isArray(cached.manifest.styles) && Array.isArray(cached.manifest.assets)
      && ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'].every(key => {
        const variant = cached.manifest.variants?.[key as SkinVariant];
        const tokens = variant?.tokens;
        return variant && Array.isArray(variant.styles) && variant.icons && variant.decorations && tokens
          && ['primary', 'primarySoft', 'surface', 'elevated', 'background', 'text', 'textSecondary', 'border', 'danger', 'success', 'warning'].every(token => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(tokens[token as keyof typeof tokens])))
          && typeof tokens.fontFamily === 'string' && [tokens.fontSize, tokens.radius, tokens.controlHeight].every(Number.isFinite)
          && Array.isArray(tokens.chartColors) && tokens.chartColors.length >= 2;
      })) return { ...cached, baseUrl: '/api/skins/assets/' + cached.manifest.id + '/' + cached.manifest.version + '/' };
  } catch { /* 缓存不可用时使用内置外观。 */ }
  return fallback;
}
function initialMode(): ColorMode { try { const mode = localStorage.getItem(MODE_KEY); return mode === 'light' || mode === 'dark' ? mode : 'system'; } catch { return 'system'; } }

interface SkinContextValue {
  skin: SkinDescriptor; variant: SkinVariant; mode: ColorMode; busy: boolean; error: string;
  setMode: (mode: ColorMode) => void; apply: (skin: SkinDescriptor) => Promise<void>; refresh: () => Promise<void>;
}
const SkinContext = createContext<SkinContextValue | null>(null);
export function useSkin() { const value = useContext(SkinContext); if (!value) throw new Error('皮肤环境未初始化'); return value; }

export default function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkin] = useState<SkinDescriptor>(initialSkin);
  const [mode, updateMode] = useState<ColorMode>(initialMode);
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 1023px)').matches);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const desiredVariant = ((mobile ? 'mobile' : 'desktop') + '-' + (mode === 'system' ? dark ? 'dark' : 'light' : mode)) as SkinVariant;
  const [variant, setVariant] = useState<SkinVariant>(desiredVariant);
  const current = useRef({ skin, variant: desiredVariant }); current.current = { skin, variant: desiredVariant };
  const generation = useRef(0);
  const applying = useRef(false);
  const initialized = useRef(false);
  const tokens = skin.manifest.variants[variant].tokens;

  useLayoutEffect(() => { setSkinVariables(document.documentElement, tokens); }, [tokens]);
  useEffect(() => {
    const color = matchMedia('(prefers-color-scheme: dark)'); const device = matchMedia('(max-width: 1023px)');
    const onColor = () => setDark(color.matches); const onDevice = () => setMobile(device.matches);
    color.addEventListener('change', onColor); device.addEventListener('change', onDevice);
    return () => { color.removeEventListener('change', onColor); device.removeEventListener('change', onDevice); };
  }, []);

  const activate = useCallback(async (candidate: SkinDescriptor, save: boolean) => {
    const sequence = ++generation.current;
    const variants: SkinVariant[] = ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'];
    const prepared: Awaited<ReturnType<typeof prepareSkin>>[] = [];
    try {
      // 四种效果先全部就绪，保存期间切换设备或明暗也不会留下半完成状态。
      for (const candidateVariant of variants) prepared.push(await prepareSkin(candidate, candidateVariant));
      if (sequence !== generation.current) return;
      if (save) await api.put('/api/skins/active', { id: candidate.manifest.id, version: candidate.manifest.version });
      if (sequence !== generation.current) return;
      const activeVariant = current.current.variant;
      const selected = prepared[variants.indexOf(activeVariant)];
      selected.activate();
      prepared.splice(variants.indexOf(activeVariant), 1);
      setSkin(candidate); setVariant(activeVariant); initialized.current = true;
    } finally { prepared.forEach(item => item.dispose()); }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(candidate)); } catch { /* 浏览器禁用存储时当前会话仍然可用。 */ }
    setError('');
  }, []);

  const apply = useCallback(async (candidate: SkinDescriptor) => {
    if (applying.current) return;
    applying.current = true; setBusy(true);
    try { await activate(candidate, true); }
    finally { applying.current = false; setBusy(false); }
  }, [activate]);

  const refresh = useCallback(async () => {
    if (applying.current) return;
    const sequence = generation.current;
    const candidate = await api.get<SkinDescriptor>('/api/skins/active');
    if (applying.current || sequence !== generation.current) return;
    if (initialized.current && candidate.hash === current.current.skin.hash) return;
    await activate(candidate, false);
  }, [activate]);

  useEffect(() => {
    if (applying.current) return;
    void activate(current.current.skin, false).catch(async e => {
      setError(e instanceof Error ? e.message : '皮肤加载失败');
      if (!initialized.current) {
        setSkin(fallback);
        try { await activate(fallback, false); } catch {
          const root = document.documentElement; root.dataset.skin = 'modern@1.0.0';
          root.dataset.mode = current.current.variant.endsWith('dark') ? 'dark' : 'light'; root.style.colorScheme = root.dataset.mode;
          document.querySelectorAll('link[data-skin-dynamic]').forEach(link => link.remove());
          setSkinVariables(root, fallback.manifest.variants[current.current.variant].tokens);
        }
      }
    });
  }, [activate, desiredVariant]);
  useEffect(() => {
    const sync = () => { if (document.visibilityState === 'visible') void refresh().catch(() => undefined); };
    sync(); window.addEventListener('focus', sync); document.addEventListener('visibilitychange', sync);
    return () => { window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [refresh]);
  const setMode = (value: ColorMode) => { updateMode(value); try { localStorage.setItem(MODE_KEY, value); } catch { /* 当前会话保持偏好。 */ } };

  return <SkinContext.Provider value={{ skin, variant, mode, busy, error, setMode, apply, refresh }}>
    <SkinAssetsContext.Provider value={{ skin, variant }}><ConfigProvider button={{ autoInsertSpace: false }} locale={zhCN} theme={skinTheme(tokens, variant.endsWith('dark'))}><AntApp>{children}</AntApp></ConfigProvider></SkinAssetsContext.Provider>
  </SkinContext.Provider>;
}

export function ColorModeSwitch() {
  const { mode, setMode } = useSkin();
  return <Segmented aria-label="明暗模式" value={mode} onChange={value => setMode(value as ColorMode)} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]} />;
}

export function SkinDecorations({ slot }: { slot: 'background' | 'header' | 'sidebar' | 'content' | 'footer' }) {
  const { skin, variant } = useSkin(); const asset = skin.manifest.variants[variant].decorations[slot];
  return asset ? <div aria-hidden="true" className="skin-decoration" data-skin-decoration={slot} style={{ backgroundImage: 'url("' + skin.baseUrl + asset + '")' }} /> : null;
}
