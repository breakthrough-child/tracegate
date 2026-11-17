// Experiment 4: judge reliability MACHINERY. No API key was available, so NO real LLM judge was evaluated.
// A simulated judge with KNOWN injected error and position-bias rates is used to check that Tracegate's
// calibration (agreement, Cohen's kappa) and position-swap pairwise judging recover those known quantities.
// Labels are "ground truth by construction" (a correct answer vs a deliberately corrupted one), NOT human annotations.
import { calibrateJudge, pairwise, rng, wilson, type Judge } from '@tracegate/core';
import { meta, save } from './lib.js';
import { ORDERS, KB } from 'support-agent-example/dist/data.js';

type Item = { id: string; question: string; good: string; bad: string };
const items: Item[] = [];
ORDERS.slice(0, 30).forEach((o, i) => {
  const other = ORDERS[(i + 1) % 30].status === o.status ? ORDERS[(i + 2) % 30] : ORDERS[(i + 1) % 30];
  items.push({
    id: `o${i}`,
    question: `Where is order ${o.order_id}?`,
    good: `Order ${o.order_id} (${o.item}) is ${o.status}.`,
    bad: `Order ${o.order_id} (${o.item}) is ${other.status}.`,
  });
});
KB.forEach((d, i) =>
  items.push({
    id: `k${i}`,
    question: `Policy ${d.id}?`,
    good: `"${d.text}" [${d.id}]`,
    bad: `"${KB[(i + 3) % KB.length].text}" [${d.id}]`,
  }),
);
const RUBRIC = 'Pass only if the answer states the correct fact for the question.';

/** Simulated judge: perceives truth (marker "TRUE:" is embedded by the harness) and errs with probability `flip`; prefers "A" with probability `biasA` in pairwise calls. */
function simJudge(flip: number, biasA: number, seed: number): Judge {
  const r = rng(seed);
  return {
    model: `simulated(flip=${flip},biasA=${biasA})`,
    temperature: 0,
    async complete(_s, user) {
      if (user.includes('ANSWER A:')) {
        const a = /ANSWER A:\n([\s\S]*?)\n\nANSWER B:/.exec(user)![1].includes('[GOOD]');
        let w = a ? 'A' : 'B';
        if (r() < flip) w = w === 'A' ? 'B' : 'A';
        if (r() < biasA) w = 'A';
        return JSON.stringify({ winner: w });
      }
      const good = user.includes('[GOOD]');
      return JSON.stringify({ verdict: (r() < flip ? !good : good) ? 'pass' : 'fail', reasoning: 'sim' });
    },
  };
}
const calib = items.flatMap((it) => [
  { id: it.id + '-g', rubric: RUBRIC, question: it.question, answer: it.good + ' [GOOD]', human: 'pass' as const },
  { id: it.id + '-b', rubric: RUBRIC, question: it.question, answer: it.bad, human: 'fail' as const },
]);

const calibration = [];
for (const flip of [0, 0.05, 0.1, 0.2, 0.3]) {
  const reps: { agreement: number; kappa: number }[] = [];
  for (let s = 0; s < 20; s++) {
    const rep = await calibrateJudge(simJudge(flip, 0, 100 + s), calib);
    reps.push({ agreement: rep.agreement, kappa: rep.kappa });
  }
  const m = (k: 'agreement' | 'kappa') => reps.reduce((a, b) => a + b[k], 0) / reps.length;
  calibration.push({
    injected_flip_rate: flip,
    expected_agreement: 1 - flip,
    measured_mean_agreement: m('agreement'),
    measured_mean_kappa: m('kappa'),
    n_items: calib.length,
    repeats: 20,
  });
}

const pos = [];
for (const biasA of [0, 0.2, 0.4]) {
  const N = 400;
  let accNo = 0,
    accSwap = 0,
    incons = 0,
    ties = 0;
  const j = simJudge(0.05, biasA, 7 + Math.round(biasA * 10));
  for (let n = 0; n < N; n++) {
    const it = items[n % items.length];
    const goodFirst = n % 2 === 0; // balanced presentation order
    const a = goodFirst ? it.good + ' [GOOD]' : it.bad,
      b = goodFirst ? it.bad : it.good + ' [GOOD]';
    const truth = goodFirst ? 'A' : 'B';
    // the simulated judge identifies [GOOD] in whichever slot it appears
    const noSwap = await pairwise(j, RUBRIC, it.question, a, b, false);
    const swap = await pairwise(j, RUBRIC, it.question, a, b, true);
    if (noSwap.winner === truth) accNo++;
    if (swap.inconsistent) incons++;
    if (swap.winner === 'tie') ties++;
    if (swap.winner === truth) accSwap++;
  }
  pos.push({
    injected_position_bias_toward_A: biasA,
    pairs: N,
    accuracy_without_swap: accNo / N,
    accuracy_with_swap: accSwap / N,
    share_verdicts_flagged_order_dependent: incons / N,
    share_ties_after_swap: ties / N,
    accuracy_among_decided_with_swap: accSwap / Math.max(N - ties, 1),
  });
}
save(
  'e4-judge.json',
  meta({
    experiment: 'judge calibration and position-swap machinery',
    real_judge_evaluated: false,
    judge: 'SIMULATED, known error rates',
    labels: 'ground truth by construction, not human-annotated',
    items: calib.length,
    calibration,
    position_swap: pos,
    not_measured: [
      'agreement of any real LLM judge with human labels (no API key available)',
      'effect of rubric wording on a real judge (needs a real judge)',
    ],
    wilson_example_for_n: wilson(Math.round(calib.length * 0.9), calib.length),
  }),
);
