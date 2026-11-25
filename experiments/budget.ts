/**
 * Hard spending guard for real-model experiments. Before each call it reserves a worst-case cost (a conservative
 * input estimate plus the full max_tokens) and refuses the call if spent + reserved would pass the cap.
 * Every call is appended to a ledger file, so the cap covers all invocations together, not just one run.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export class BudgetExceeded extends Error {}

export interface LedgerEntry {
  ts: string;
  phase: string;
  ok: boolean;
  input_tokens?: number;
  output_tokens?: number;
  /** actual cost from reported usage, or the worst case when the call failed and its usage is unknown */
  cost_usd: number;
  error?: string;
}
type Usage = { input_tokens: number; output_tokens: number };

export class Budget {
  private spentUsd = 0;
  private reservedUsd = 0;
  exceeded = false;
  constructor(
    readonly capUsd: number,
    readonly price: { input: number; output: number },
    private ledger?: string,
  ) {
    if (!(capUsd > 0)) throw new Error('budget cap must be a positive number');
    if (ledger && existsSync(ledger)) this.spentUsd = Budget.read(ledger).reduce((a, e) => a + e.cost_usd, 0);
  }
  static read(file: string): LedgerEntry[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }
  get spent(): number {
    return this.spentUsd;
  }
  cost(u: Usage): number {
    return (u.input_tokens * this.price.input + u.output_tokens * this.price.output) / 1e6;
  }
  /** Run one call under the guard. `requestChars / 2` over-estimates input tokens for English and JSON. */
  async call<T>(phase: string, requestChars: number, maxTokens: number, fn: () => Promise<{ value: T; usage?: Usage }>): Promise<T> {
    const worst = this.cost({ input_tokens: Math.ceil(requestChars / 2) + 1000, output_tokens: maxTokens });
    if (this.exceeded || this.spentUsd + this.reservedUsd + worst > this.capUsd) {
      this.exceeded = true;
      throw new BudgetExceeded(`budget guard: $${this.spentUsd.toFixed(4)} spent, next call could pass the $${this.capUsd} cap`);
    }
    this.reservedUsd += worst;
    try {
      const { value, usage } = await fn();
      this.record({ phase, ok: true, ...usage, cost_usd: usage ? this.cost(usage) : worst });
      return value;
    } catch (e) {
      this.record({ phase, ok: false, cost_usd: worst, error: String((e as Error).message).slice(0, 200) });
      throw e;
    } finally {
      this.reservedUsd -= worst;
    }
  }
  private record(e: Omit<LedgerEntry, 'ts'>): void {
    this.spentUsd += e.cost_usd;
    if (this.ledger) appendFileSync(this.ledger, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  }
}
