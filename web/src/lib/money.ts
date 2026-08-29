const SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  AUD: 'A$',
  CAD: 'C$',
};

export function currencyPrefix(currency = 'CNY'): string {
  const code = currency.toUpperCase();
  if (code === 'CNY') return SYMBOLS.CNY;
  return `${code} ${SYMBOLS[code] ?? ''}`.trim();
}

export function formatMoney(amount: number, currency = 'CNY'): string {
  const code = currency.toUpperCase();
  const fractionDigits = code === 'JPY' || code === 'KRW' ? 0 : 2;
  const value = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
  return SYMBOLS[code] ? `${currencyPrefix(code)}${value}` : `${currencyPrefix(code)} ${value}`;
}
