/**
 * Statistics implemented from first principles (no dependency).
 * See docs/STATISTICS.md for assumptions and when not to trust each test.
 */

/** Small seeded PRNG (mulberry32) so every bootstrap is reproducible. */
export function rng(seed = 12345): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
export const stdev = (xs: number[]): number => Math.sqrt(variance(xs));

/** Linear-interpolation quantile (type 7, the R/NumPy default). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface Interval {
  estimate: number;
  lo: number;
  hi: number;
  n: number;
}

/**
 * Cluster bootstrap: `groups[i]` holds all observations for case i (all its trials).
 * Cases are resampled with replacement, which respects the correlation between trials of one case.
 * `stat` receives the pooled observations of the resampled cases.
 */
export function bootstrapCI(
  groups: number[][],
  stat: (pooled: number[]) => number = mean,
  opts: { iters?: number; alpha?: number; seed?: number } = {},
): Interval {
  const { iters = 2000, alpha = 0.05, seed = 1 } = opts;
  const n = groups.length;
  const estimate = stat(groups.flat());
  if (n < 2) return { estimate, lo: estimate, hi: estimate, n };
  const r = rng(seed);
  const draws: number[] = [];
  for (let b = 0; b < iters; b++) {
    const pooled: number[] = [];
    for (let i = 0; i < n; i++) pooled.push(...groups[Math.floor(r() * n)]);
    draws.push(stat(pooled));
  }
  return { estimate, lo: quantile(draws, alpha / 2), hi: quantile(draws, 1 - alpha / 2), n };
}

/** Wilson score interval for a binomial proportion (used for rates in experiments). */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { estimate: NaN, lo: NaN, hi: NaN, n };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { estimate: p, lo: (c - h) / d, hi: (c + h) / d, n };
}

export interface PairedDiff {
  diff: number;
  lo: number;
  hi: number;
  n: number;
  /** Cohen's d_z: mean difference divided by the sd of paired differences. */
  effect_size: number;
  /** Two-sided p-value from a sign-flip permutation... see pairedBootstrapP */
  p: number;
}

/**
 * Paired bootstrap on per-case differences (candidate - baseline).
 * `a[i]` and `b[i]` are the per-case values (usually mean over trials) for the same case.
 * The p-value is a bootstrap p-value for H0: mean diff = 0, via bootstrapping the
 * mean-centred differences (Efron & Tibshirani, ch. 16).
 */
export function pairedBootstrap(
  a: number[],
  b: number[],
  opts: { iters?: number; alpha?: number; seed?: number } = {},
): PairedDiff {
  if (a.length !== b.length) throw new Error('pairedBootstrap: length mismatch');
  const { iters = 4000, alpha = 0.05, seed = 7 } = opts;
  const d = a.map((x, i) => b[i] - x);
  const n = d.length;
  const diff = mean(d);
  const sd = stdev(d);
  const effect_size = sd > 0 ? diff / sd : diff === 0 ? 0 : Math.sign(diff) * Infinity;
  if (n < 2) return { diff, lo: diff, hi: diff, n, effect_size, p: 1 };
  const r = rng(seed);
  const draws: number[] = [];
  const centred = d.map((x) => x - diff);
  let extreme = 0;
  for (let t = 0; t < iters; t++) {
    let s = 0;
    let s0 = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(r() * n);
      s += d[j];
      s0 += centred[j];
    }
    draws.push(s / n);
    if (Math.abs(s0 / n) >= Math.abs(diff) - 1e-12) extreme++;
  }
  return {
    diff,
    lo: quantile(draws, alpha / 2),
    hi: quantile(draws, 1 - alpha / 2),
    n,
    effect_size,
    p: (extreme + 1) / (iters + 1),
  };
}

/* ---------- exact binomial / McNemar ---------- */

function logGamma(x: number): number {
  // Lanczos approximation
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export const logChoose = (n: number, k: number): number =>
  k < 0 || k > n ? -Infinity : logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p = 0.5): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}

export interface McNemarResult {
  /** pairs that passed in baseline but failed in candidate */
  regressed: number;
  /** pairs that failed in baseline but passed in candidate */
  improved: number;
  discordant: number;
  /** exact two-sided p-value (binomial on discordant pairs, p=0.5) */
  p: number;
}
/** Exact McNemar test: two-sided binomial test on discordant pairs. */
export function mcnemarExact(baselinePass: boolean[], candidatePass: boolean[]): McNemarResult {
  if (baselinePass.length !== candidatePass.length) throw new Error('mcnemarExact: length mismatch');
  let regressed = 0;
  let improved = 0;
  baselinePass.forEach((b, i) => {
    if (b && !candidatePass[i]) regressed++;
    if (!b && candidatePass[i]) improved++;
  });
  const n = regressed + improved;
  if (n === 0) return { regressed, improved, discordant: 0, p: 1 };
  const p = Math.min(1, 2 * binomCdf(Math.min(regressed, improved), n, 0.5));
  return { regressed, improved, discordant: n, p };
}

/** Unbiased pass@k estimator (Chen et al., 2021): 1 - C(n-c, k) / C(n, k). */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) k = n;
  if (n - c < k) return 1;
  return 1 - Math.exp(logChoose(n - c, k) - logChoose(n, k));
}

/** Cohen's kappa for two raters over the same items (categorical labels). */
export function cohenKappa<T>(a: T[], b: T[]): { kappa: number; agreement: number; n: number } {
  if (a.length !== b.length) throw new Error('cohenKappa: length mismatch');
  const n = a.length;
  if (!n) return { kappa: NaN, agreement: NaN, n };
  const labels = [...new Set([...a, ...b])];
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  const po = agree / n;
  let pe = 0;
  for (const l of labels) pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, agreement: po, n };
}

/** A case is flaky when its pass/fail outcome is not the same across all trials. */
export const isFlaky = (passes: boolean[]): boolean => passes.length > 1 && new Set(passes).size > 1;

export type Verdict = 'regression' | 'improvement' | 'no_significant_change' | 'insufficient_data';

/**
 * Classify a paired difference. `tolerance` is the smallest drop (in metric units) worth
 * failing on. Needs `minCases` paired cases, otherwise says plainly that data is insufficient.
 */
export function classifyDiff(d: PairedDiff, tolerance = 0, minCases = 10): Verdict {
  if (d.n < minCases) return 'insufficient_data';
  if (d.hi < 0 && d.diff <= -tolerance) return 'regression';
  if (d.lo > 0 && d.diff >= tolerance) return 'improvement';
  return 'no_significant_change';
}
