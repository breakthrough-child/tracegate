// Experiment 3: detection power for injected regressions (the degraded prompt changes behaviour on d% of cases).
import { cases, decide, firstTrials, meanOf, meta, rate, runSet, save } from './lib.js';

const REPS = 60,
  MAXT = 10,
  NOISE = 0.05;
const DEGR = [0.05, 0.1, 0.2];
const TS = [1, 3, 5, 10];
const hits: Record<string, number> = {};
const trueDrop: Record<string, number[]> = {};
for (let i = 0; i < REPS; i++) {
  const base = await runSet('base', { noise: NOISE, seedBase: 100 + i }, MAXT);
  for (const d of DEGR) {
    const cand = await runSet('cand', { variant: 'prompt', degrade: d, degradeSalt: 0, noise: NOISE, seedBase: 5000 + i }, MAXT);
    const pr = (r: typeof base) => meanOf(r.cases.map((c) => c.trials.filter((t) => t.pass).length / c.trials.length));
    (trueDrop[d] ??= []).push(pr(base) - pr(cand));
    for (const t of TS) if (decide(firstTrials(base, t), firstTrials(cand, t)).regression) hits[`${d}|${t}`] = (hits[`${d}|${t}`] ?? 0) + 1;
  }
  if ((i + 1) % 10 === 0) console.log(`rep ${i + 1}/${REPS}`);
}
const table = DEGR.map((d) => ({
  degrade_fraction_of_cases: d,
  observed_mean_pass_rate_drop: meanOf(trueDrop[d]),
  detection_rate_by_trials: Object.fromEntries(TS.map((t) => [t, rate(hits[`${d}|${t}`] ?? 0, REPS)])),
}));
save(
  'e3-sensitivity.json',
  meta({
    experiment: 'detection power vs number of trials',
    replications: REPS,
    noise_per_call: NOISE,
    tolerance: 0.02,
    cases: cases.length,
    table,
    note: 'The "degrade" parameter sets the share of cases on which the degraded prompt skips the order lookup; the realised drop in pass rate is reported separately because not every degraded case fails (some answers still pass).',
  }),
);
