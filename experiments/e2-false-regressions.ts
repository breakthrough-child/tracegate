// Experiment 2: false regressions between two IDENTICAL (simulated) agents.
import { cases, decide, firstTrials, meta, rate, runSet, save } from './lib.js';

const REPS = 300,
  TRIALS = 5,
  NOISE = 0.05;
let naiveAny = 0,
  naiveTol = 0,
  tgBoot = 0,
  tgMc = 0,
  tgBoot1 = 0;
for (let i = 0; i < REPS; i++) {
  const a = await runSet('a', { noise: NOISE, seedBase: 2 * i + 1 }, TRIALS);
  const b = await runSet('b', { noise: NOISE, seedBase: 2 * i + 2 }, TRIALS);
  const a1 = firstTrials(a, 1),
    b1 = firstTrials(b, 1);
  const pa = a1.cases.filter((c) => c.trials[0].pass).length / cases.length,
    pb = b1.cases.filter((c) => c.trials[0].pass).length / cases.length;
  if (pb < pa) naiveAny++; // naive rule 1: any drop in pass rate between two single runs
  if (pb < pa - 0.02) naiveTol++; // naive rule 2: drop of more than 2 percentage points (one case = 2.5 pts)
  if (decide(a, b).regression) tgBoot++; // Tracegate: 5 trials, paired bootstrap CI excludes 0 and drop >= tolerance
  if (decide(a, b).mcnemarP < 0.05 && decide(a, b).diff < 0) tgMc++;
  if (decide(a1, b1).regression) tgBoot1++; // Tracegate's test but with only 1 trial per case
  if ((i + 1) % 50 === 0) console.log(`rep ${i + 1}/${REPS}`);
}
save(
  'e2-false-regressions.json',
  meta({
    experiment: 'false regressions between identical agents',
    replications: REPS,
    trials_for_tracegate: TRIALS,
    noise_per_call: NOISE,
    naive_any_drop_single_run: rate(naiveAny, REPS),
    naive_drop_over_2pts_single_run: rate(naiveTol, REPS),
    tracegate_1_trial_paired_bootstrap: rate(tgBoot1, REPS),
    tracegate_5_trials_paired_bootstrap: rate(tgBoot, REPS),
    mcnemar_exact_p_lt_0_05_5_trials: rate(tgMc, REPS),
    note: 'Both sides are the same agent with different random seeds, so every flagged regression is a false positive. Intervals are Wilson 95%.',
  }),
);
