// Experiment 6: budget gates under noise. SIMULATED agent. (a) identical agents: how often does a naive single-run
// cost/latency threshold raise a false alarm vs Tracegate's statistically supported check? (b) injected real cost
// increases (a model that emits more output tokens): how much increase before each rule reliably fires?
import { caseMetric, quantile } from '@tracegate/core';
import { decide, firstTrials, meanOf, meta, rate, runSet, save } from './lib.js';

const REPS = 150,
  TRIALS = 5,
  NOISE = 0.05,
  TOL = 0.05;
const meanMetric = (r: Awaited<ReturnType<typeof runSet>>, m: string) => meanOf(r.cases.map((c) => caseMetric(c, m) ?? 0));
const fp = { naive_cost: 0, naive_p95: 0, tg_cost: 0, tg_latency: 0 };
for (let i = 0; i < REPS; i++) {
  const a = await runSet('a', { noise: NOISE, seedBase: 2 * i + 1 }, TRIALS);
  const b = await runSet('b', { noise: NOISE, seedBase: 2 * i + 2 }, TRIALS);
  const a1 = firstTrials(a, 1),
    b1 = firstTrials(b, 1);
  if (meanMetric(b1, 'cost_usd') > meanMetric(a1, 'cost_usd') * (1 + TOL)) fp.naive_cost++;
  const p95 = (r: typeof a) =>
    quantile(
      r.cases.flatMap((c) => c.trials.map((t) => t.latency_ms)),
      0.95,
    );
  if (p95(b1) > p95(a1) * (1 + TOL)) fp.naive_p95++;
  if (decide(a, b, 'cost_usd', TOL, true).regression) fp.tg_cost++;
  if (decide(a, b, 'latency_ms', TOL, true).regression) fp.tg_latency++;
}
const SCALES = [1.05, 1.1, 1.25, 1.5, 2];
const power = [];
for (const s of SCALES) {
  let naive = 0,
    tg = 0,
    inc = 0;
  const R = 60;
  for (let i = 0; i < R; i++) {
    const a = await runSet('a', { noise: NOISE, seedBase: 900 + 2 * i }, TRIALS);
    const b = await runSet('b', { noise: NOISE, seedBase: 901 + 2 * i, outputScale: s }, TRIALS);
    inc += meanMetric(b, 'cost_usd') / meanMetric(a, 'cost_usd') - 1;
    if (meanMetric(firstTrials(b, 1), 'cost_usd') > meanMetric(firstTrials(a, 1), 'cost_usd') * (1 + TOL)) naive++;
    if (decide(a, b, 'cost_usd', TOL, true).regression) tg++;
  }
  power.push({
    output_token_multiplier: s,
    realised_mean_cost_increase: inc / R,
    replications: R,
    naive_single_run_fires: rate(naive, R),
    tracegate_5_trials_fires: rate(tg, R),
  });
}
save(
  'e6-budgets.json',
  meta({
    experiment: 'budget gates under noise',
    tolerance_relative: TOL,
    noise_per_call: NOISE,
    false_alarm_replications: REPS,
    identical_agents: {
      naive_single_run_mean_cost_over_tolerance: rate(fp.naive_cost, REPS),
      naive_single_run_p95_latency_over_tolerance: rate(fp.naive_p95, REPS),
      tracegate_cost_5_trials: rate(fp.tg_cost, REPS),
      tracegate_mean_latency_5_trials: rate(fp.tg_latency, REPS),
    },
    injected_cost_increase: power,
    note: 'Cost noise here comes only from behavioural slips (extra/missing tool steps) and is small; real model output lengths vary much more, so naive false-alarm rates on real models are likely higher. Not measured.',
  }),
);
