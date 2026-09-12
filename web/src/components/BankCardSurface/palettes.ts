/**
 * 卡片封面 32 色表（唯一来源）。
 * 前 5 个沿用历史 p0-p4 原色原序，其余按色相族排列（红/橙/金/绿/青/蓝/紫/洋红/中性各 3）。
 * ink 为渐变暗端、color 为主色端；主色端亮度统一 30%，保证卡面白字对比度。
 * 上限与 server/src/routes/cards.routes.ts 中 colorPalette 校验（0-31）联动，扩色需同步。
 */
export interface CardPalette {
  /** 色块悬停提示名 */
  name: string;
  /** 渐变暗端 */
  ink: string;
  /** 渐变主色端 */
  color: string;
}

export const CARD_PALETTES: CardPalette[] = [
  { name: '深海蓝', ink: '#10213e', color: '#24466e' },
  { name: '酒红', ink: '#381b28', color: '#693348' },
  { name: '墨绿', ink: '#0c2e31', color: '#1a5550' },
  { name: '紫檀', ink: '#271c3c', color: '#4f3b68' },
  { name: '棕金', ink: '#362718', color: '#66502c' },
  { name: '绯红', ink: '#301212', color: '#732626' },
  { name: '砖红', ink: '#301a12', color: '#733926' },
  { name: '玫红', ink: '#301218', color: '#732636' },
  { name: '焦橙', ink: '#301f12', color: '#734626' },
  { name: '琥珀', ink: '#302312', color: '#735026' },
  { name: '赭石', ink: '#301c12', color: '#734026' },
  { name: '芥末金', ink: '#302912', color: '#736026' },
  { name: '秋香金', ink: '#302c12', color: '#736926' },
  { name: '古铜金', ink: '#302512', color: '#735726' },
  { name: '松绿', ink: '#123017', color: '#267333' },
  { name: '苔绿', ink: '#1a3012', color: '#397326' },
  { name: '竹青', ink: '#123024', color: '#267353' },
  { name: '深青', ink: '#12302c', color: '#267369' },
  { name: '孔雀青', ink: '#122c30', color: '#266973' },
  { name: '湖青', ink: '#123026', color: '#267359' },
  { name: '宝蓝', ink: '#121f30', color: '#264673' },
  { name: '靛蓝', ink: '#121830', color: '#263673' },
  { name: '湖蓝', ink: '#122530', color: '#265773' },
  { name: '葡萄紫', ink: '#1d1230', color: '#422673' },
  { name: '紫罗兰', ink: '#251230', color: '#572673' },
  { name: '兰紫', ink: '#161230', color: '#302673' },
  { name: '紫红', ink: '#2e1230', color: '#6c2673' },
  { name: '洋红', ink: '#30122a', color: '#732663' },
  { name: '桃红', ink: '#301224', color: '#732653' },
  { name: '石墨灰', ink: '#1d2026', color: '#3d4a5c' },
  { name: '暖褐', ink: '#281f1a', color: '#624537' },
  { name: '橄榄', ink: '#25271b', color: '#595f3a' },
];

export const CARD_PALETTE_COUNT = CARD_PALETTES.length;

/** 自动分配：按卡片 id 在全色表轮换（无 colorPalette 字段时回退） */
export function autoPalette(cardId: number): number {
  return ((cardId % CARD_PALETTE_COUNT) + CARD_PALETTE_COUNT) % CARD_PALETTE_COUNT;
}

/** 越界兜底取模，并输出卡面渐变所需的两个 CSS 变量 */
export function paletteVars(palette: number): Record<string, string> {
  const p = CARD_PALETTES[((palette % CARD_PALETTE_COUNT) + CARD_PALETTE_COUNT) % CARD_PALETTE_COUNT];
  return { '--bcs-ink': p.ink, '--bcs-color': p.color };
}

/** 色块预览渐变（选择器用） */
export function paletteGradient(palette: number): string {
  const p = CARD_PALETTES[((palette % CARD_PALETTE_COUNT) + CARD_PALETTE_COUNT) % CARD_PALETTE_COUNT];
  return `linear-gradient(135deg, ${p.ink}, ${p.color})`;
}

export function paletteName(palette: number): string {
  return CARD_PALETTES[((palette % CARD_PALETTE_COUNT) + CARD_PALETTE_COUNT) % CARD_PALETTE_COUNT].name;
}
