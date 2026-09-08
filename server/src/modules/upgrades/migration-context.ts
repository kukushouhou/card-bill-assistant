/** 只取盘点或旧任务保存的实际银行，不把解析器支持范围当成用户受影响范围。 */
export function affectedBankNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const banks = (payload as Record<string, unknown>).banks;
  if (!Array.isArray(banks)) return [];
  return [...new Set(banks.filter((bank): bank is string => typeof bank === 'string' && bank.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
