/**
 * Shared helpers for the experiments. Everything here uses the SIMULATED support agent (mock model):
 * no network, no API key. Results from these scripts must be labelled "simulated".
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  AgentContext,
  caseMetric,
  classifyDiff,
  mcnemarExact,
  pairedBootstrap,
  runFromEvents,
  scoreRun,
  wilson,
  type Case,
  type CaseResult,
  type RunsetResults,
  type TraceEvent,
  type TracegateConfig,
} from '@tracegate/core';
import { createSupportAgent, type SupportOptions } from 'support-agent-example/dist/agent.js';

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS = join(here, 'results');
export const cases: Case[] = YAML.parse(readFileSync(join(here, '../examples/support-agent/dataset.yaml'), 'utf8'));

const cfgModule = await import(join(here, '../examples/support-agent/tracegate.config.mjs'));
export const cfg: TracegateConfig = cfgModule.default;

/** Run + score the whole dataset in memory (no disk), `trials` trials per case. */
export async function runSet(name: string, opts: SupportOptions, trials: number, caseList: Case[] = cases): Promise<RunsetResults> {
  const agent = createSupportAgent(opts);
  const out: CaseResult[] = [];
  for (const c of caseList) {
    const tr = [];
    for (let t = 0; t < trials; t++) {
      const events: TraceEvent[] = [];
      const tg = new AgentContext({ case: c, trial: t, mode: 'live', meta: { simulated: true }, sink: (e) => events.push(e) });
      tg.start(c.input);
      try {
        tg.end({ status: 'ok', output: await agent(c.input, tg) });
      } catch (e) {
        tg.end({ status: 'error', error: String(e) });
      }
      tr.push(await scoreRun(c, runFromEvents(events), cfg));
    }
    out.push({ case_id: c.id, category: c.category, tags: c.tags ?? [], trials: tr });
  }
  return { name, created: new Date().toISOString(), meta: { simulated: true }, cases: out };
}

/** Restrict results to the first `t` trials of each case (valid: trials are independent). */
export const firstTrials = (r: RunsetResults, t: number): RunsetResults => ({
  ...r,
  cases: r.cases.map((c) => ({ ...c, trials: c.trials.slice(0, t) })),
});

export interface Decision {
  regression: boolean;
  diff: number;
  lo: number;
  hi: number;
  p: number;
  mcnemarP: number;
}
/** Tracegate's decision rule for one metric: paired bootstrap CI + tolerance (see check.ts). */
export function decide(base: RunsetResults, cand: RunsetResults, metric = 'task_success', tolerance = 0.02, lowerBetter = false): Decision {
  const a: number[] = [],
    b: number[] = [];
  for (const c of base.cases) {
    const d = cand.cases.find((x) => x.case_id === c.case_id);
    if (!d) continue;
    const x = caseMetric(c, metric),
      y = caseMetric(d, metric);
    if (x !== null && y !== null) {
      a.push(x);
      b.push(y);
    }
  }
  const diff = pairedBootstrap(a, b, { iters: 1500 });
  const signed = lowerBetter ? { ...diff, diff: -diff.diff, lo: -diff.hi, hi: -diff.lo } : diff;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const tol = lowerBetter ? tolerance * meanA : tolerance;
  const m = mcnemarExact(
    base.cases.map((c) => c.trials.filter((t) => t.pass).length / c.trials.length > 0.5),
    cand.cases.map((c) => c.trials.filter((t) => t.pass).length / c.trials.length > 0.5),
  );
  return {
    regression: classifyDiff(signed, tol, 10) === 'regression',
    diff: diff.diff,
    lo: diff.lo,
    hi: diff.hi,
    p: diff.p,
    mcnemarP: m.p,
  };
}

export const rate = (k: number, n: number) => {
  const w = wilson(k, n);
  return { k, n, rate: k / n, ci95: [w.lo, w.hi] as [number, number] };
};
export const save = (name: string, data: unknown) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, name), JSON.stringify(data, null, 2));
  console.log(`saved results/${name}`);
};
export const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const sdOf = (xs: number[]) => {
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(xs.length - 1, 1));
};
export const meta = (extra: Record<string, unknown>) => ({
  generated: new Date().toISOString(),
  node: process.version,
  simulated: true,
  dataset_cases: cases.length,
  ...extra,
});
