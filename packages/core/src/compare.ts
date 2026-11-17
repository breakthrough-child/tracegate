import {
  bootstrapCI,
  classifyDiff,
  isFlaky,
  mcnemarExact,
  mean,
  passAtK,
  pairedBootstrap,
  quantile,
  type Interval,
  type McNemarResult,
  type PairedDiff,
  type Verdict,
} from './stats.js';
import { caseMetric, metricNames } from './scoring.js';
import type { CaseResult, RunsetResults } from './types.js';

export interface MetricSummary {
  name: string;
  ci: Interval;
}
export interface Summary {
  name: string;
  n_cases: number;
  trials_per_case: number;
  metrics: MetricSummary[];
  p95_latency_ms: Interval;
  pass_at_k?: { k: number; value: number };
  flaky_cases: string[];
  safety_violations: number;
}

const LOWER_IS_BETTER = new Set(['cost_usd', 'latency_ms', 'tokens', 'steps', 'failure_rate']);
export const lowerIsBetter = (m: string): boolean => LOWER_IS_BETTER.has(m);

const summaryCache = new WeakMap<RunsetResults, Summary>();
export function summarize(r: RunsetResults, seed = 1): Summary {
  const hit = seed === 1 ? summaryCache.get(r) : undefined;
  if (hit) return hit;
  const out = summarizeUncached(r, seed);
  if (seed === 1) summaryCache.set(r, out);
  return out;
}

function summarizeUncached(r: RunsetResults, seed: number): Summary {
  const metrics: MetricSummary[] = [];
  for (const name of [...metricNames(r), 'failure_rate']) {
    const groups: number[][] = [];
    for (const c of r.cases) {
      const v = caseMetric(c, name);
      if (v !== null) groups.push([v]);
    }
    if (groups.length) metrics.push({ name, ci: bootstrapCI(groups, undefined, { seed }) });
  }
  const latGroups = r.cases.map((c) => c.trials.map((t) => t.latency_ms));
  const trials = Math.max(0, ...r.cases.map((c) => c.trials.length));
  const k = Math.min(trials, 3);
  const pk =
    r.cases.length && trials > 1 ? mean(r.cases.map((c) => passAtK(c.trials.length, c.trials.filter((t) => t.pass).length, k))) : undefined;
  return {
    name: r.name,
    n_cases: r.cases.length,
    trials_per_case: trials,
    metrics,
    p95_latency_ms: bootstrapCI(latGroups, (xs) => quantile(xs, 0.95), { seed, iters: 1000 }),
    pass_at_k: pk === undefined ? undefined : { k, value: pk },
    flaky_cases: r.cases.filter((c) => isFlaky(c.trials.map((t) => t.pass))).map((c) => c.case_id),
    safety_violations: r.cases.reduce((a, c) => a + c.trials.reduce((b, t) => b + t.safety_violations.length, 0), 0),
  };
}

export interface MetricComparison {
  name: string;
  baseline: number;
  candidate: number;
  diff: PairedDiff;
  verdict: Verdict;
  /** true when higher values are worse (cost, latency, ...) */
  lower_is_better: boolean;
}
export interface CaseChange {
  case_id: string;
  category?: string;
  tags: string[];
  kind: 'regressed' | 'improved' | 'flaky' | 'unchanged';
  baseline_pass_rate: number;
  candidate_pass_rate: number;
  failures: string[];
}
export interface Comparison {
  baseline: Summary;
  candidate: Summary;
  n_paired: number;
  only_in_baseline: string[];
  only_in_candidate: string[];
  metrics: MetricComparison[];
  pass_test: McNemarResult;
  by_category: { category: string; n: number; baseline: number; candidate: number; diff: number }[];
  changes: CaseChange[];
  cost_quality: { baseline: { quality: number; cost: number }; candidate: { quality: number; cost: number } };
  notes: string[];
}

const passRate = (c: CaseResult): number => mean(c.trials.map((t) => (t.pass ? 1 : 0)));

export function compare(
  base: RunsetResults,
  cand: RunsetResults,
  opts: { tolerance?: number; min_cases?: number; alpha?: number } = {},
): Comparison {
  const tol = opts.tolerance ?? 0.02;
  const bm = new Map(base.cases.map((c) => [c.case_id, c]));
  const cm = new Map(cand.cases.map((c) => [c.case_id, c]));
  const ids = [...bm.keys()].filter((id) => cm.has(id));
  const notes: string[] = [];
  const metrics: MetricComparison[] = [];
  const names = new Set([...metricNames(base), ...metricNames(cand)]);
  for (const name of names) {
    const a: number[] = [];
    const b: number[] = [];
    for (const id of ids) {
      const x = caseMetric(bm.get(id)!, name);
      const y = caseMetric(cm.get(id)!, name);
      if (x !== null && y !== null) {
        a.push(x);
        b.push(y);
      }
    }
    if (!a.length) continue;
    const diff = pairedBootstrap(a, b, { alpha: opts.alpha });
    const lib = lowerIsBetter(name);
    // classify in "quality" direction: positive diff = better
    const signed = lib ? { ...diff, diff: -diff.diff, lo: -diff.hi, hi: -diff.lo } : diff;
    const relTol = lib ? tol * Math.max(mean(a), 1e-12) : tol;
    const verdict = classifyDiff(signed, relTol, opts.min_cases ?? 10);
    metrics.push({ name, baseline: mean(a), candidate: mean(b), diff, verdict, lower_is_better: lib });
  }
  const tp = (c: CaseResult) => passRate(c) > 0.5;
  const pass_test = mcnemarExact(
    ids.map((i) => tp(bm.get(i)!)),
    ids.map((i) => tp(cm.get(i)!)),
  );
  const changes: CaseChange[] = ids.map((id) => {
    const x = bm.get(id)!,
      y = cm.get(id)!;
    const bp = passRate(x),
      cp = passRate(y);
    const flaky = isFlaky(x.trials.map((t) => t.pass)) || isFlaky(y.trials.map((t) => t.pass));
    const kind = cp < bp - 1e-9 ? 'regressed' : cp > bp + 1e-9 ? 'improved' : flaky ? 'flaky' : 'unchanged';
    return {
      case_id: id,
      category: y.category,
      tags: y.tags,
      kind,
      baseline_pass_rate: bp,
      candidate_pass_rate: cp,
      failures: [...new Set(y.trials.flatMap((t) => t.failures))].slice(0, 4),
    };
  });
  const cats = new Map<string, string[]>();
  for (const id of ids) cats.set(cm.get(id)!.category ?? '(none)', [...(cats.get(cm.get(id)!.category ?? '(none)') ?? []), id]);
  const by_category = [...cats.entries()].map(([category, cs]) => {
    const b = mean(cs.map((i) => passRate(bm.get(i)!)));
    const c = mean(cs.map((i) => passRate(cm.get(i)!)));
    return { category, n: cs.length, baseline: b, candidate: c, diff: c - b };
  });
  const q = (r: RunsetResults) => mean(r.cases.filter((c) => ids.includes(c.case_id)).map(passRate));
  const cost = (r: RunsetResults) => mean(r.cases.filter((c) => ids.includes(c.case_id)).map((c) => mean(c.trials.map((t) => t.cost_usd))));
  const bt = Math.max(...base.cases.map((c) => c.trials.length)),
    ct = Math.max(...cand.cases.map((c) => c.trials.length));
  if (Math.min(bt, ct) < 3)
    notes.push(
      `Only ${Math.min(bt, ct)} trial(s) per case: run-to-run noise is poorly estimated. Use --trials 5 or more for reliable gating.`,
    );
  if (ids.length < (opts.min_cases ?? 10))
    notes.push(`Only ${ids.length} paired cases: there is not enough data to conclude anything (minimum ${opts.min_cases ?? 10}).`);
  if (
    base.cases.some((c) => c.trials.some((t) => t.simulated_latency)) ||
    cand.cases.some((c) => c.trials.some((t) => t.simulated_latency))
  )
    notes.push('Latency figures include simulated latency from the mock model.');
  return {
    baseline: summarize(base),
    candidate: summarize(cand),
    n_paired: ids.length,
    only_in_baseline: [...bm.keys()].filter((i) => !cm.has(i)),
    only_in_candidate: [...cm.keys()].filter((i) => !bm.has(i)),
    metrics,
    pass_test,
    by_category,
    changes,
    notes,
    cost_quality: { baseline: { quality: q(base), cost: cost(base) }, candidate: { quality: q(cand), cost: cost(cand) } },
  };
}
