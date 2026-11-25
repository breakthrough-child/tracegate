/**
 * Experiment 7: REAL model (claude-haiku-5-5), not simulated. Costs money; never run by `pnpm experiments`.
 *
 *   tsx experiments/e7-real-model.ts smoke     3 cases x 1 trial, prints the real cost per case
 *   tsx experiments/e7-real-model.ts run       20 cases x 3 trials x 2 variants
 *   tsx experiments/e7-real-model.ts judge     LLM-judge 10 of the recorded answers
 *   tsx experiments/e7-real-model.ts analyze   recompute results/e7-real-model.json from the saved traces (free)
 *
 * Add --mock to exercise the whole script with the mock model and no network (writes to tmp-out/).
 * Fixed before any real call was made: the case sample, the refusal pattern, the two prompts and the settings below.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicJudge, simulatedJudge } from '@tracegate/adapters';
import {
  Store,
  actionSummary,
  answerText,
  check,
  judgeAnswer,
  runDataset,
  scoreRunset,
  wilson,
  type Case,
  type Judge,
  type RunsetResults,
} from '@tracegate/core';
import YAML from 'yaml';
import { createSupportAgent, type Variant } from 'support-agent-example/dist/agent.js';
import { Budget } from './budget.js';
import { cases, cfg, meanOf, sdOf } from './lib.js';

const MODEL = 'claude-haiku-5-5';
const PRICE = { input: 0.1, output: 0.5 };
const TRIALS = 3;
const CONCURRENCY = 3;
const HARD_CAP_USD = 0.35;
const REQUEST = { max_tokens: 1500, output_config: { effort: 'low' } };
const REFUSAL = /\b(can(?:'|’)?t|cannot|unable|not able|won(?:'|’)?t)\b/i;
const VARIANTS: { name: string; variant: Variant; note: string }[] = [
  { name: 'real-baseline', variant: 'good', note: 'SYSTEM_GOOD' },
  { name: 'real-worse', variant: 'prompt', note: 'SYSTEM_TERSE: told to skip lookups, policy rules removed' },
];
/** Every second case of the 40, so each category keeps its share. */
const SAMPLE: Case[] = cases.filter((_, i) => i % 2 === 0);

const args = process.argv.slice(2);
const mock = args.includes('--mock');
const phase = args.find((a) => !a.startsWith('--')) ?? '';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = mock ? join(here, '../tmp-out/e7') : join(here, 'results');
const store = new Store(join(OUT, 'e7-real'));
const LEDGER = join(OUT, 'e7-ledger.jsonl');
const RESULT = join(OUT, 'e7-real-model.json');
const prices = { [MODEL]: PRICE };
mkdirSync(OUT, { recursive: true });

function apiKey(): string {
  if (process.env.TRACEGATE_E7_KEY) return process.env.TRACEGATE_E7_KEY;
  const line = readFileSync(join(here, '../.env.local'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const key = line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^"|"$/g, '');
  if (!key) throw new Error('ANTHROPIC_API_KEY not found in .env.local');
  return key;
}
const cap = Math.min(Number(process.env.EXPERIMENT_BUDGET_USD ?? HARD_CAP_USD), HARD_CAP_USD);
const budget = new Budget(cap, PRICE, LEDGER);

/** One non-streaming Messages API call over fetch (no SDK dependency). A failed call is retried at most once. */
async function callApi(
  req: Record<string, unknown>,
): Promise<{ content: unknown[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // the URL is explicit so a proxy configured in the shell is not used by accident
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as never;
    } catch (e) {
      last = e as Error;
      if (/API 4(0[0-3]|04|22)/.test(last.message)) break; // client errors are not retried
    }
  }
  throw last;
}

/** Anthropic-shaped client whose every call goes through the budget guard. */
const guardedClient = (label: string) => () => ({
  messages: {
    create: (req: Record<string, unknown>) =>
      budget.call(label, JSON.stringify(req).length, Number(req.max_tokens), async () => {
        const value = await callApi(req);
        return { value, usage: value.usage };
      }),
  },
});

async function runVariant(name: string, variant: Variant, caseList: Case[], trials: number, label: string): Promise<void> {
  if (existsSync(store.runsetDir(name))) throw new Error(`${store.runsetDir(name)} already exists; refusing to spend money on it twice`);
  const agent = createSupportAgent(
    mock
      ? { variant, noise: 0.05, degrade: 0.5 }
      : { variant, model: MODEL, client: guardedClient(label), request: REQUEST, refusal: REFUSAL },
  );
  const res = await runDataset({
    cases: caseList,
    agent,
    store,
    name,
    trials,
    concurrency: CONCURRENCY,
    prices: mock ? undefined : prices,
    dataset: 'examples/support-agent/dataset.yaml',
    meta: { agent: 'support-agent', model: mock ? 'mock-large' : MODEL, prompt_version: variant, simulated: mock },
  });
  console.log(`${name}: ${res.runs} runs, ${res.errors} errors, spent so far $${budget.spent.toFixed(5)} of $${cap}`);
  if (budget.exceeded) {
    console.error('ABORTED by the budget guard; traces so far are kept but are incomplete');
    process.exit(2);
  }
}

async function score(name: string): Promise<{ results: RunsetResults; dropped: number }> {
  const runs = store.loadRuns(name);
  // A run that ended in an error (API failure) says nothing about the agent, so it is dropped and reported.
  const usable = runs.filter((r) => r.status === 'ok');
  return { results: await scoreRunset(store, SAMPLE, usable, { config: cfg, name }), dropped: runs.length - usable.length };
}

const trialRates = (r: RunsetResults) =>
  Array.from({ length: TRIALS }, (_, t) => {
    const ts = r.cases.map((c) => c.trials.find((x) => x.trial === t)).filter((x) => x !== undefined);
    return { trial: t, passed: ts.filter((x) => x.pass).length, n: ts.length };
  });
const describeVariant = (r: RunsetResults, dropped: number) => {
  const all = r.cases.flatMap((c) => c.trials);
  const per = trialRates(r);
  const rates = per.map((p) => p.passed / p.n);
  const flaky = r.cases.filter((c) => c.trials.some((t) => t.pass) && c.trials.some((t) => !t.pass));
  const w = wilson(all.filter((t) => t.pass).length, all.length);
  return {
    cases: r.cases.length,
    trial_runs: all.length,
    dropped_error_runs: dropped,
    passed: all.filter((t) => t.pass).length,
    pass_rate: all.filter((t) => t.pass).length / all.length,
    pass_rate_wilson95_ignoring_clustering: [w.lo, w.hi],
    pass_rate_by_trial: per.map((p, i) => ({ ...p, rate: rates[i] })),
    run_to_run: { mean: meanOf(rates), sd: sdOf(rates), min: Math.min(...rates), max: Math.max(...rates), runs: rates.length },
    flaky_cases: flaky.map((c) => ({ case_id: c.case_id, passed: c.trials.filter((t) => t.pass).length, trials: c.trials.length })),
    always_failing_cases: r.cases
      .filter((c) => c.trials.every((t) => !t.pass))
      .map((c) => ({ case_id: c.case_id, why: c.trials[0].failures[0] })),
    safety_violations: all.reduce((a, t) => a + t.safety_violations.length, 0),
    mean_cost_usd_per_run: meanOf(all.map((t) => t.cost_usd)),
    mean_tokens_per_run: meanOf(all.map((t) => t.tokens)),
    mean_latency_ms: meanOf(all.map((t) => t.latency_ms)),
  };
};

async function analyze(): Promise<void> {
  const [b, w] = [await score(VARIANTS[0].name), await score(VARIANTS[1].name)];
  const res = check(w.results, b.results, { ...cfg, thresholds: {}, budgets: {} });
  const cmp = res.comparison!;
  const task = cmp.metrics.find((m) => m.name === 'task_success')!;
  const [pb, pw] = [trialRates(b.results), trialRates(w.results)];
  const ledger = existsSync(LEDGER) ? Budget.read(LEDGER) : [];
  const byPhase = (p: string) => ledger.filter((e) => e.phase === p);
  const sum = (es: typeof ledger) => es.reduce((a, e) => a + e.cost_usd, 0);
  const judged = join(OUT, 'e7-judge.json');
  writeFileSync(
    RESULT,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        experiment: 'real-model run of the support agent: run-to-run noise and detection of a deliberately worsened prompt',
        simulated: mock,
        model: mock ? 'mock-large' : MODEL,
        settings: { ...REQUEST, thinking: 'model default (adaptive)', temperature: 'not set (model default)', max_retries_per_call: 1 },
        price_usd_per_mtok: PRICE,
        sample: {
          cases: SAMPLE.length,
          of_dataset: cases.length,
          rule: 'every second dataset case (even index), fixed before any real call',
          trials_per_case: TRIALS,
          variants: VARIANTS,
          case_ids: SAMPLE.map((c) => c.id),
        },
        baseline: describeVariant(b.results, b.dropped),
        worse: describeVariant(w.results, w.dropped),
        comparison: {
          metric: 'task_success',
          paired_cases: cmp.n_paired,
          baseline: task.baseline,
          candidate: task.candidate,
          diff: task.diff,
          verdict: task.verdict,
          mcnemar: cmp.pass_test,
          gate_tolerance: cfg.tolerance,
          detected_by_paired_test: task.verdict === 'regression',
          gate_failed: !res.ok,
          findings: res.findings,
          naive_single_run_drop_by_trial: pb.map((x, i) => ({
            trial: i,
            baseline: x.passed / x.n,
            worse: pw[i].passed / pw[i].n,
            dropped: pw[i].passed / pw[i].n < x.passed / x.n,
          })),
          other_metrics: cmp.metrics
            .filter((m) =>
              ['tool_accuracy', 'answer_checks', 'outcome', 'behavior_correct', 'cost_usd', 'tokens', 'latency_ms'].includes(m.name),
            )
            .map((m) => ({
              name: m.name,
              n: m.diff.n,
              baseline: m.baseline,
              candidate: m.candidate,
              diff: m.diff.diff,
              lo: m.diff.lo,
              hi: m.diff.hi,
              verdict: m.verdict,
            })),
        },
        cost: {
          budget_cap_usd: cap,
          total_usd: sum(ledger),
          smoke_usd: sum(byPhase('smoke')),
          run_usd: sum(byPhase('run')),
          judge_usd: sum(byPhase('judge')),
          api_calls: ledger.length,
          failed_calls: ledger.filter((e) => !e.ok).length,
          input_tokens: ledger.reduce((a, e) => a + (e.input_tokens ?? 0), 0),
          output_tokens: ledger.reduce((a, e) => a + (e.output_tokens ?? 0), 0),
          note: 'Computed from the token usage the API reported and the list price above; failed calls are charged at their worst case.',
        },
        judge: existsSync(judged) ? JSON.parse(readFileSync(judged, 'utf8')) : 'not yet measured',
        limits: [
          '20 cases and 3 trials per variant: the statistics are weak; only large differences can be detected and the intervals are wide.',
          'One model, one worsened prompt, one day, one synthetic dataset written for a mock agent.',
          'Run-to-run sd is estimated from 3 runs, which is a very rough estimate.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${RESULT}`);
}

async function judge(): Promise<void> {
  const out = join(OUT, 'e7-judge.json');
  if (existsSync(out)) throw new Error(`${out} already exists; refusing to pay for it twice`);
  const rubrics = YAML.parse(readFileSync(join(here, '../examples/support-agent/rubrics.yaml'), 'utf8')) as Record<string, string>;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  const real = anthropicJudge({ model: MODEL, apiKey: mock ? 'x' : apiKey(), effort: 'low', maxTokens: 1500, onUsage: (u) => (usage = u) });
  const guarded: Judge = {
    model: real.model,
    complete: (s, u) => budget.call('judge', s.length + u.length, 1500, async () => ({ value: await real.complete(s, u), usage })),
  };
  const j = mock ? simulatedJudge(0.5) : guarded;
  const runs = VARIANTS.map((v) => store.loadRuns(v.name));
  const scored = VARIANTS.map((v) => store.readResults(v.name)!);
  const items = [];
  // 10 items: cases 0,2,4,... of the sample, alternating baseline and worse answers
  for (let k = 0; k < 10; k++) {
    const c = SAMPLE[k * 2];
    const v = k % 2;
    const run = runs[v].find((r) => r.case_id === c.id && r.trial === 0);
    const trial = scored[v].cases.find((x) => x.case_id === c.id)?.trials.find((t) => t.trial === 0);
    if (!run || !trial) continue;
    const verdict = await judgeAnswer(j, rubrics[c.id], String(c.input), answerText(run), actionSummary(run));
    items.push({
      case_id: c.id,
      variant: VARIANTS[v].name,
      judge_pass: verdict.pass,
      scorer_pass: trial.pass,
      reasoning: verdict.reasoning,
    });
  }
  const agree = items.filter((i) => i.judge_pass === i.scorer_pass).length;
  writeFileSync(
    out,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        simulated: mock,
        judge: j.model,
        n: items.length,
        judge_passed: items.filter((i) => i.judge_pass).length,
        agrees_with_deterministic_scorers: agree,
        note: 'Agreement is with Tracegate rule-based scorers, NOT with human labels. Human agreement and kappa: not yet measured. 10 items is far too few for a rate.',
        items,
      },
      null,
      2,
    ),
  );
  console.log(`judged ${items.length}: ${agree} agree with the deterministic scorers`);
}

if (phase === 'smoke') {
  const smoke = [SAMPLE[0], SAMPLE[5], SAMPLE[12]];
  await runVariant('real-smoke', 'good', smoke, 1, 'smoke');
  const runs = store.loadRuns('real-smoke');
  for (const r of runs) {
    const calls = r.events.filter((e) => e.type === 'model_call');
    console.log(
      `  ${r.case_id} [${r.status}] ${calls.length} calls $${calls.reduce((a, e) => a + (e.cost_usd ?? 0), 0).toFixed(6)}  ${r.error ?? ''}`,
    );
    console.log(`    ${answerText(r).slice(0, 160).replace(/\n/g, ' ')}`);
  }
  const per = budget.spent / runs.length;
  const projected = per * SAMPLE.length * TRIALS * VARIANTS.length;
  console.log(
    `real cost per case: $${per.toFixed(6)}; projected full run: $${projected.toFixed(4)} (cap $${cap}, spent $${budget.spent.toFixed(5)})`,
  );
  if (budget.spent + projected > cap) {
    console.error('PROJECTED COST EXCEEDS THE CAP: do not run the full experiment');
    process.exit(2);
  }
} else if (phase === 'run') {
  for (const v of VARIANTS) await runVariant(v.name, v.variant, SAMPLE, TRIALS, 'run');
  await analyze();
} else if (phase === 'judge') {
  await judge();
  await analyze();
} else if (phase === 'analyze') await analyze();
else console.log('usage: tsx experiments/e7-real-model.ts smoke|run|judge|analyze [--mock]');
