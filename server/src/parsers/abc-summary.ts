import { normalizeCurrency, parseAmount } from './_util';

/** 农行摘要的币种和金额成对出现，零值也必须完整保留。 */
export function abcSummaryAmounts(text: string): Array<{ currency: string; amount: number }> {
  const currencies = [...text.matchAll(/[（(]([A-Z]{3})[）)]/g)];
  return currencies.map((match, index) => {
    const value = text.slice(match.index! + match[0].length, currencies[index + 1]?.index)
      .match(/^\s*(-?[\d,]+\.\d{2})(?![\d.])/);
    const amount = value ? parseAmount(value[1]) : null;
    if (amount == null) throw new Error('农行账单摘要存在无法完整读取的金额');
    return { currency: normalizeCurrency(match[1]), amount: Math.abs(amount) };
  });
}
