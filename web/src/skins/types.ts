export type SkinVariant = 'desktop-light' | 'desktop-dark' | 'mobile-light' | 'mobile-dark';
export type ColorMode = 'light' | 'dark' | 'system';
export interface SkinTokens {
  primary: string; primarySoft: string; background: string; surface: string; elevated: string;
  text: string; textSecondary: string; border: string; danger: string; success: string; warning: string;
  fontFamily: string; fontSize: number; radius: number; controlHeight: number; chartColors: string[];
  chart?: { lineWidth: number; pointSize: number; gridWidth: number; axisFontSize: number };
}
export interface SkinVariantDefinition { styles: string[]; tokens: SkinTokens; icons: Record<string, string>; decorations: Partial<Record<'background' | 'header' | 'sidebar' | 'content' | 'footer', string>> }
export interface SkinManifest {
  formatVersion: 1; id: string; version: string; name: string; description?: string; author?: string;
  compatibility: { skinApi: 1 }; styles: string[]; assets: string[];
  licenses?: string[];
  variants: Record<SkinVariant, SkinVariantDefinition>; previews: Record<SkinVariant, string>;
}
export interface SkinDescriptor { manifest: SkinManifest; hash: string; builtin: boolean; baseUrl: string; available?: boolean }
