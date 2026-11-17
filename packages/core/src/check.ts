import { compare, summarize, type Comparison } from './compare.js';
import type { TracegateConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import { quantile } from './stats.js';
import type { RunsetResults } from './types.js';

export interface Finding {
  level: 'fail' | 'warn' | 'info';
  kind: 'safety' | 'threshold' | 'regression' | 'budget' | 'data';
  message: string;
}
export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  comparison?: Comparison;
}

const fmt = (x: number, d = 3) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d));

/**
 * The CI gate. Fails when: any safety rule is violated; a metric is below its absolute threshold;
 * a gated metric is a statistically significant regression beyond tolerance; or a budget is exceeded.
 */
export function check(cand: RunsetResults, base: RunsetResults | undefined, cfg: TracegateConfig = {}): CheckResult {
  const findings: Finding[] = [];
  const tol = cfg.tolerance ?? DEFAULT_CONFIG.tolerance;
  const sum = summarize(cand);
  if (sum.safety_violations) {
    const ex = cand.cases.flatMap((c) => c.trials.flatMap((t) => t.safety_violations.map((v) => `${c.case_id}: ${v}`))).slice(0, 5);
    findings.push({ level: 'fail', kind: 'safety', message: `${sum.safety_violations} safety violation(s). ${ex.join(' | ')}` });
  }
  for (const [m, floor] of Object.entries(cfg.thresholds ?? {})) {
    const v = sum.metrics.find((x) => x.name === m);
    if (!v) findings.push({ level: 'warn', kind: 'threshold', message: `threshold metric "${m}" not present in candidate` });
    else if (v.ci.estimate < floor)
      findings.push({ level: 'fail', kind: 'threshold', message: `${m} = ${fmt(v.ci.estimate)} is below the threshold ${floor}` });
  }
  const b = cfg.budgets ?? {};
  const costs = cand.cases.map((c) => c.trials.reduce((a, t) => a + t.cost_usd, 0) / c.trials.length);
  const meanCost = costs.reduce((a, x) => a + x, 0) / Math.max(costs.length, 1);
  if (b.max_mean_cost_usd !== undefined && meanCost > b.max_mean_cost_usd)
    findings.push({
      level: 'fail',
      kind: 'budget',
      message: `mean cost $${fmt(meanCost, 5)} per case exceeds budget $${b.max_mean_cost_usd}`,
    });
  const p95 = quantile(
    cand.cases.flatMap((c) => c.trials.map((t) => t.latency_ms)),
    0.95,
  );
  if (b.max_p95_latency_ms !== undefined && p95 > b.max_p95_latency_ms)
    findings.push({ level: 'fail', kind: 'budget', message: `p95 latency ${fmt(p95, 0)} ms exceeds budget ${b.max_p95_latency_ms} ms` });
  const tokens = sum.metrics.find((m) => m.name === 'tokens')?.ci.estimate ?? 0;
  if (b.max_mean_tokens !== undefined && tokens > b.max_mean_tokens)
    findings.push({ level: 'fail', kind: 'budget', message: `mean tokens ${fmt(tokens, 0)} exceed budget ${b.max_mean_tokens}` });

  let comparison: Comparison | undefined;
  if (base) {
    comparison = compare(base, cand, { tolerance: tol, alpha: cfg.alpha, min_cases: cfg.min_cases });
    const gated = cfg.gate_metrics ?? DEFAULT_CONFIG.gate_metrics;
    for (const m of comparison.metrics) {
      if (gated.includes(m.name)) {
        if (m.verdict === 'regression')
          findings.push({
            level: 'fail',
            kind: 'regression',
            message: `${m.name} regressed: ${fmt(m.baseline)} -> ${fmt(m.candidate)} (diff ${fmt(m.diff.diff)}, 95% CI ${fmt(m.diff.lo)} to ${fmt(m.diff.hi)}, p=${fmt(m.diff.p)})`,
          });
        else if (m.verdict === 'insufficient_data')
          findings.push({ level: 'warn', kind: 'data', message: `${m.name}: too few paired cases (${m.diff.n}) to test for regression` });
      }
      if (
        m.lower_is_better &&
        (m.name === 'cost_usd' || m.name === 'latency_ms' || m.name === 'tokens') &&
        b.max_relative_increase !== undefined
      ) {
        const rel = m.baseline ? m.diff.diff / m.baseline : 0;
        if (m.diff.lo > 0 && rel > b.max_relative_increase)
          findings.push({
            level: 'fail',
            kind: 'budget',
            message: `${m.name} rose ${(rel * 100).toFixed(1)}% (CI ${fmt(m.diff.lo)} to ${fmt(m.diff.hi)} above zero), more than the allowed ${(b.max_relative_increase * 100).toFixed(0)}%`,
          });
      }
    }
    for (const n of comparison.notes) findings.push({ level: 'info', kind: 'data', message: n });
  } else
    findings.push({ level: 'info', kind: 'data', message: 'No baseline given: only safety rules, thresholds and budgets were checked.' });
  return { ok: !findings.some((f) => f.level === 'fail'), findings, comparison };
}
