export interface Price {
  /** USD per million input tokens */
  input: number;
  /** USD per million output tokens */
  output: number;
}
export type PriceTable = Record<string, Price>;

/** Example default prices. They go stale: override them in tracegate.config for real cost figures. */
export const DEFAULT_PRICES: PriceTable = {
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4': { input: 1, output: 5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'mock-large': { input: 3, output: 15 },
  'mock-small': { input: 0.25, output: 1.25 },
};

export function costOf(table: PriceTable, model: string, usage?: { input_tokens: number; output_tokens: number }): number | undefined {
  if (!usage) return undefined;
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(k));
  if (!key) return undefined;
  const p = table[key];
  return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1e6;
}
