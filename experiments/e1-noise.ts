// Experiment 1: run-to-run noise. SIMULATED agent (mock model) with 5% per-call behavioural slip probability.
import { caseMetric, isFlaky } from '@tracegate/core';
import { cases, meanOf, meta, runSet, sdOf, save } from './lib.js';

const SEEDS = 10,
  TRIALS = 5,
  NOISE = 0.05;
const runs = [];
for (let s = 0; s < SEEDS; s++) runs.push(await runSet(`e1-${s}`, { noise: NOISE, seedBase: s + 1 }, TRIALS));
const metrics = ['task_success', 'tool_accuracy', 'cost_usd', 'latency_ms'];
const perRun: Record<string, number[]> = {},
  singleTrial: Record<string, number[]> = {};
for (const m of metrics) {
  perRun[m] = runs.map((r) => meanOf(r.cases.map((c) => caseMetric(c, m) ?? NaN)));
  singleTrial[m] = runs.map((r) =>
    meanOf(
      r.cases.map((c) => {
        const t = c.trials[0];
        return m === 'task_success'
          ? t.pass
            ? 1
            : 0
          : m === 'cost_usd'
            ? t.cost_usd
            : m === 'latency_ms'
              ? t.latency_ms
              : (t.scores[m] ?? NaN);
      }),
    ),
  );
}
const sum = (xs: number[]) => ({ mean: meanOf(xs), sd: sdOf(xs), min: Math.min(...xs), max: Math.max(...xs) });
// flakiness: how many cases flip between trials, pooled over independent runs
const flakyCount = new Map<string, number>();
const flakyPerRun: number[] = [];
for (const r of runs) {
  const f = r.cases.filter((c) => isFlaky(c.trials.map((t) => t.pass)));
  flakyPerRun.push(f.length);
  f.forEach((c) => flakyCount.set(c.case_id, (flakyCount.get(c.case_id) ?? 0) + 1));
}
save(
  'e1-noise.json',
  meta({
    experiment: 'run-to-run noise',
    agent: 'simulated support agent',
    noise_per_call: NOISE,
    independent_runs: SEEDS,
    trials_per_run: TRIALS,
    five_trial_mean_across_runs: Object.fromEntries(metrics.map((m) => [m, sum(perRun[m])])),
    single_trial_across_runs: Object.fromEntries(metrics.map((m) => [m, sum(singleTrial[m])])),
    flaky_cases_per_run: sum(flakyPerRun),
    flaky_case_frequency: Object.fromEntries([...flakyCount.entries()].sort((a, b) => b[1] - a[1])),
    note: 'All runs use the identical agent; any spread is run-to-run noise. Noise level is an assumption of the simulation, not a measurement of real models.',
    n_cases: cases.length,
  }),
);
