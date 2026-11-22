/**
 * Budget validation for LLM router settings.
 * Blank/empty string means no cap (null).
 * Positive numbers or zero are valid.
 * Negative numbers or non-finite values are invalid.
 */
export function parseBudgetInput(value: string): { valid: boolean; value?: number | null; error?: string } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { valid: true, value: null };
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    return { valid: false, error: 'Budget must be a non-negative number or blank for no cap.' };
  }
  return { valid: true, value: num };
}
