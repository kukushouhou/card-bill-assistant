import { theme, type ThemeConfig } from 'antd';
import type { SkinDescriptor, SkinTokens, SkinVariant } from './types';

export function skinTheme(tokens: SkinTokens, dark: boolean): ThemeConfig {
  return {
    algorithm: (seed, map) => ({
      ...(dark ? theme.darkAlgorithm : theme.defaultAlgorithm)(seed, map),
      colorPrimary: tokens.primary, colorPrimaryHover: tokens.primary, colorPrimaryActive: tokens.primary,
      colorLink: tokens.primary, colorLinkHover: tokens.text, colorLinkActive: tokens.primary,
      colorInfo: tokens.primary, colorSuccess: tokens.success, colorError: tokens.danger, colorWarning: tokens.warning,
      ...Object.fromEntries(Object.entries({ blue: tokens.primary, green: tokens.success, red: tokens.danger, gold: tokens.warning, orange: tokens.warning })
        .flatMap(([name, color]) => [[name + '1', name === 'blue' ? tokens.primarySoft : tokens.surface], [name + '3', tokens.border], [name + '6', color], [name + '7', color]])),
    }),
    token: {
      colorPrimary: tokens.primary, colorPrimaryText: tokens.primary, colorPrimaryTextHover: tokens.text, colorPrimaryTextActive: tokens.primary, colorPrimaryBg: tokens.primarySoft, colorPrimaryBgHover: tokens.primarySoft, colorInfo: tokens.primary, colorInfoText: tokens.primary, colorBgLayout: tokens.background, colorBgContainer: tokens.surface,
      colorBgElevated: tokens.elevated, colorText: tokens.text, colorTextSecondary: tokens.textSecondary,
      colorTextDescription: tokens.textSecondary, colorTextTertiary: tokens.textSecondary, colorTextLabel: tokens.text,
      colorTextLightSolid: dark ? tokens.background : '#ffffff',
      colorBorder: tokens.border, colorBorderSecondary: tokens.border,
      colorError: tokens.danger, colorSuccess: tokens.success, colorWarning: tokens.warning,
      fontFamily: tokens.fontFamily, fontSize: tokens.fontSize, borderRadius: tokens.radius,
      borderRadiusLG: tokens.radius + 4, controlHeight: tokens.controlHeight,
    },
    components: { Button: { primaryColor: dark ? tokens.background : '#ffffff' }, Menu: { itemSelectedColor: dark ? tokens.text : tokens.primary, itemSelectedBg: tokens.primarySoft } },
  };
}

export function setSkinVariables(root: HTMLElement, tokens: SkinTokens) {
  const values: Record<string, string> = {
    primary: tokens.primary, 'primary-soft': tokens.primarySoft, background: tokens.background,
    surface: tokens.surface, elevated: tokens.elevated, text: tokens.text, 'text-secondary': tokens.textSecondary,
    border: tokens.border, danger: tokens.danger, success: tokens.success, warning: tokens.warning,
    'radius': tokens.radius + 'px', 'radius-lg': tokens.radius + 4 + 'px',
    'font-family': tokens.fontFamily, 'font-size': tokens.fontSize + 'px',
    'surface-hover': tokens.primarySoft,
    'ant-color-primary': tokens.primary, 'ant-color-primary-bg': tokens.primarySoft,
    'ant-color-text': tokens.text, 'ant-color-text-secondary': tokens.textSecondary,
    'ant-color-border': tokens.border, 'ant-color-border-secondary': tokens.border,
    'ant-color-bg-container': tokens.surface, 'ant-color-bg-elevated': tokens.elevated,
    'ant-color-bg-layout': tokens.background,
    'adm-color-primary': tokens.primary, 'adm-color-text': tokens.text,
    'adm-color-text-secondary': tokens.textSecondary, 'adm-color-weak': tokens.textSecondary,
    'adm-color-border': tokens.border, 'adm-color-background': tokens.surface,
    'adm-color-box': tokens.background, 'adm-color-fill-content': tokens.background,
    'adm-color-danger': tokens.danger, 'adm-color-success': tokens.success,
    'adm-font-family': tokens.fontFamily, 'adm-font-size-main': tokens.fontSize + 'px',
  };
  Object.entries(values).forEach(([key, value]) => root.style.setProperty('--' + key, value));
}

function assetUrl(skin: SkinDescriptor, asset: string) {
  // 描述来自服务端；缓存损坏时也不会加载任意远程地址。
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(skin.manifest.id) || !/^[\w.-]+$/.test(skin.manifest.version) || !/^[\w/.-]+$/.test(asset) || asset.includes('..')) throw new Error('皮肤资源地址无效');
  return '/api/skins/assets/' + skin.manifest.id + '/' + skin.manifest.version + '/' + asset;
}

const preparedAssets = new Map<string, Promise<void>>();
async function prepareAssets(skin: SkinDescriptor) {
  const key = skin.hash || skin.manifest.id + '@' + skin.manifest.version;
  let pending = preparedAssets.get(key);
  if (!pending) {
    pending = Promise.all(skin.manifest.assets.map(async (asset, index) => {
      const url = assetUrl(skin, asset);
      if (/\.(woff2?|ttf|otf)$/i.test(asset)) {
        await new FontFace('skin-validation-' + index, 'url("' + url + '")').load();
      } else {
        const image = new Image(); image.src = url; await image.decode();
      }
    })).then(() => undefined);
    preparedAssets.set(key, pending);
    pending.catch(() => preparedAssets.delete(key));
  }
  return pending;
}

/** 先加载到未启用的样式表；成功后才交换，失败时保留原外观。 */
export async function prepareSkin(skin: SkinDescriptor, variant: SkinVariant, doc: Document = document) {
  const links: HTMLLinkElement[] = [];
  const loaded = skin.manifest.styles.concat(skin.manifest.variants[variant].styles).map(file => new Promise<void>((resolve, reject) => {
    const link = doc.createElement('link'); link.rel = 'stylesheet'; link.media = 'not all'; link.href = assetUrl(skin, file); link.dataset.skinDynamic = 'pending';
    link.onload = () => resolve(); link.onerror = () => reject(new Error('皮肤样式加载失败'));
    links.push(link); doc.head.appendChild(link);
  }));
  try { await Promise.all([...loaded, prepareAssets(skin)]); }
  catch { links.forEach(link => link.remove()); throw new Error('皮肤资源无法加载，已保留原皮肤'); }
  return {
    activate() {
      const root = doc.documentElement;
      const old = [...doc.querySelectorAll<HTMLLinkElement>('link[data-skin-dynamic="active"]')];
      root.dataset.skin = skin.manifest.id + '@' + skin.manifest.version;
      root.dataset.mode = variant.endsWith('dark') ? 'dark' : 'light';
      root.style.colorScheme = root.dataset.mode;
      setSkinVariables(root, skin.manifest.variants[variant].tokens);
      links.forEach(link => { link.media = 'all'; link.dataset.skinDynamic = 'active'; });
      old.forEach(link => link.remove());
    },
    dispose() { links.forEach(link => link.remove()); },
  };
}
