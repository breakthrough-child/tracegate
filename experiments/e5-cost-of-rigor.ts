// Experiment 5: cost of multi-trial testing and savings from replay. SIMULATED model: token counts come from the mock,
// prices from the (stale, illustrative) default price table; wall-clock numbers are of the harness only, not of real LLM calls.
import { AgentContext, Store, runDataset, caseMetric, type Agent } from '@tracegate/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupportAgent } from 'support-agent-example/dist/agent.js';
import { cases, meta, runSet, save, meanOf } from './lib.js';

void AgentContext;
const rows: {
  trials: number;
  model_calls: number;
  simulated_spend_usd: number;
  simulated_sequential_model_time_s: number;
  harness_wall_clock_ms: number;
}[] = [];
for (const t of [1, 3, 5, 10]) {
  const t0 = Date.now();
  const r = await runSet('x', { noise: 0.05, seedBase: 1 }, t);
  const wall = Date.now() - t0;
  const costPerRun = meanOf(r.cases.map((c) => caseMetric(c, 'cost_usd') ?? 0)) * cases.length;
  const simLat = r.cases.reduce((a, c) => a + c.trials.reduce((b, x) => b + x.latency_ms, 0), 0);
  rows.push({
    trials: t,
    model_calls: r.cases.reduce((a, c) => a + c.trials.reduce((b, x) => b + x.steps, 0), 0),
    simulated_spend_usd: costPerRun * t,
    simulated_sequential_model_time_s: simLat / 1000,
    harness_wall_clock_ms: wall,
  });
}
// replay: count live model invocations while replaying a recorded run set
const store = new Store(mkdtempSync(join(tmpdir(), 'tg-e5-')));
const real = createSupportAgent({ noise: 0.05 });
let liveCalls = 0;
const counting: Agent = (input, tg) => {
  const orig = tg.model.bind(tg);
  tg.model = ((o: never, live: () => Promise<unknown>) =>
    orig(o, async () => {
      liveCalls++;
      return live();
    })) as typeof tg.model;
  return real(input, tg);
};
await runDataset({ cases, agent: counting, store, name: 'rec', trials: 3, meta: { simulated: true } });
const recordedCalls = liveCalls;
liveCalls = 0;
const t0 = Date.now();
await runDataset({ cases, agent: counting, store, name: 'rep', trials: 3, mode: 'replay', cassette: 'rec', meta: { simulated: true } });
const recorded = store.loadRuns('rec');
const recordedSpend = recorded.reduce((a, r) => a + r.events.reduce((b, e) => b + (e.type === 'model_call' ? (e.cost_usd ?? 0) : 0), 0), 0);
save(
  'e5-cost-of-rigor.json',
  meta({
    experiment: 'cost of rigor and savings from replay',
    by_trials: rows,
    relative_to_single_run: rows.map((r) => ({ trials: r.trials, spend_multiple: r.simulated_spend_usd / rows[0].simulated_spend_usd })),
    replay: {
      live_model_calls_when_recording: recordedCalls,
      live_model_calls_when_replaying: liveCalls,
      simulated_spend_of_recording_usd: recordedSpend,
      spend_of_replay_usd: 0,
      replay_harness_wall_clock_ms: Date.now() - t0,
    },
    note: 'Spend and model time are simulated from mock token counts and the default price table. Multi-trial cost scales linearly with trials by construction; the experiment documents the multiple and the exact zero live calls in replay. Real latency/cost not measured.',
  }),
);
