import { describe, expect, it } from 'vitest';
import { binomCdf, bootstrapCI, classifyDiff, cohenKappa, isFlaky, logChoose, mcnemarExact, mean, pairedBootstrap, passAtK, quantile, stdev, wilson } from '../src/index.js';

describe('descriptive statistics', () => {
  it('mean, sd, quantile match hand values', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 8);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10); // type-7
  });
  it('logChoose', () => {
    expect(Math.exp(logChoose(10, 3))).toBeCloseTo(120, 6);
    expect(Math.exp(logChoose(52, 5))).toBeCloseTo(2598960, 0);
  });
});

describe('exact tests', () => {
  it('binomial cdf', () => {
    expect(binomCdf(2, 12, 0.5)).toBeCloseTo(79 / 4096, 10);
    expect(binomCdf(5, 10, 0.5)).toBeCloseTo(638 / 1024, 10);
  });
  it('McNemar exact: b=2, c=10 gives p = 158/4096', () => {
    const base = [...Array(10).fill(false), ...Array(2).fill(true), ...Array(5).fill(true)];
    const cand = [...Array(10).fill(true), ...Array(2).fill(false), ...Array(5).fill(true)];
    const r = mcnemarExact(base, cand);
    expect(r.improved).toBe(10);
    expect(r.regressed).toBe(2);
    expect(r.p).toBeCloseTo(158 / 4096, 10);
  });
  it('McNemar with no discordant pairs is p=1', () => {
    expect(mcnemarExact([true, false], [true, false]).p).toBe(1);
  });
  it('McNemar 0 vs 6 gives p = 2/64', () => {
    expect(mcnemarExact(Array(6).fill(true), Array(6).fill(false)).p).toBeCloseTo(2 / 64, 10);
  });
});

describe('agreement and pass@k', () => {
  it("Cohen's kappa reference (po=.7, pe=.5 -> .4)", () => {
    const a: string[] = [], b: string[] = [];
    const add = (x: string, y: string, n: number) => { for (let i = 0; i < n; i++) { a.push(x); b.push(y); } };
    add('y', 'y', 20); add('y', 'n', 5); add('n', 'y', 10); add('n', 'n', 15);
    const k = cohenKappa(a, b);
    expect(k.agreement).toBeCloseTo(0.7, 10);
    expect(k.kappa).toBeCloseTo(0.4, 10);
  });
  it('pass@k estimator', () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 10);
    expect(passAtK(5, 2, 2)).toBeCloseTo(0.7, 10);
    expect(passAtK(5, 0, 3)).toBe(0);
    expect(passAtK(5, 4, 2)).toBe(1);
  });
  it('flakiness', () => {
    expect(isFlaky([true, true])).toBe(false);
    expect(isFlaky([true, false])).toBe(true);
  });
});

describe('bootstrap', () => {
  it('is reproducible and brackets the mean', () => {
    const g = Array.from({ length: 30 }, (_, i) => [i % 2]);
    const a = bootstrapCI(g, undefined, { seed: 3 });
    const b = bootstrapCI(g, undefined, { seed: 3 });
    expect(a).toEqual(b);
    expect(a.estimate).toBeCloseTo(0.5, 10);
    expect(a.lo).toBeLessThan(0.5);
    expect(a.hi).toBeGreaterThan(0.5);
  });
  it('wilson interval reference: 8/10 -> (0.490, 0.943)', () => {
    const w = wilson(8, 10);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
  });
  it('paired bootstrap detects a consistent drop and not a zero diff', () => {
    const a = Array.from({ length: 40 }, () => 1);
    const b = a.map((x, i) => (i < 12 ? 0 : x));
    const d = pairedBootstrap(a, b);
    expect(d.diff).toBeCloseTo(-0.3, 10);
    expect(d.hi).toBeLessThan(0);
    expect(d.p).toBeLessThan(0.01);
    const z = pairedBootstrap(a, a);
    expect(z.diff).toBe(0);
    expect(z.p).toBeGreaterThan(0.5);
  });
  it('says plainly when data is insufficient', () => {
    expect(classifyDiff({ diff: -0.5, lo: -0.9, hi: -0.1, n: 4, effect_size: -1, p: 0.1 }, 0, 10)).toBe('insufficient_data');
    expect(classifyDiff({ diff: -0.5, lo: -0.9, hi: -0.1, n: 40, effect_size: -1, p: 0.01 }, 0.02, 10)).toBe('regression');
    expect(classifyDiff({ diff: -0.5, lo: -0.9, hi: 0.1, n: 40, effect_size: -1, p: 0.2 }, 0.02, 10)).toBe('no_significant_change');
  });
});
