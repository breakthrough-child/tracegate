import { BUILTIN_SCORERS, trajectoryOf, type Judge, type Scorer, type ScoreContext } from './scorers/index.js';
import { rubricHash } from './scorers/judge.js';
import type { TracegateConfig } from './config.js';
import type { Case, CaseResult, Run, RunsetResults, ScorerResult, TrialResult } from './types.js';
import type { Store } from './store.js';
import { mean } from './stats.js';

export interface ScoreOptions {
  config?: TracegateConfig;
  judge?: Judge;
  name: string;
  dataset?: string;
  meta?: Record<string, unknown>;
}

function chunkResolver(cfg: TracegateConfig, c: Case, run: Run): (id: string) => string | undefined {
  const docs = (c.context as { docs?: Record<string, string> } | undefined)?.docs;
  const stored = new Map<string, string>();
  for (const e of run.events) if (e.type === 'retrieval') for (const r of e.results) if (r.text) stored.set(r.id, r.text);
  return (id) => stored.get(id) ?? docs?.[id] ?? cfg.corpus?.[id];
}

export async function scoreRun(c: Case, run: Run, cfg: TracegateConfig, judge?: Judge): Promise<TrialResult> {
  const scorers: Scorer[] = [...BUILTIN_SCORERS, ...(cfg.scorers ?? [])];
  const ctx: ScoreContext = {
    case: c, run, judge, safety: cfg.safety ?? [], outcomes: cfg.outcomes ?? {},
    chunkText: chunkResolver(cfg, c, run), required: cfg.required ?? {},
  };
  const results: ScorerResult[] = [];
  for (const s of scorers) {
    try {
      const r = await s.score(ctx);
      results.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      results.push({ name: s.name, score: 0, pass: false, details: `scorer threw: ${(e as Error).message}` });
    }
  }
  const failures: string[] = [];
  const safety_violations: string[] = [];
  const scores: Record<string, number | null> = {};
  for (const r of results) {
    scores[r.name] = r.score;
    if (r.score === null) continue;
    const required = cfg.required?.[r.name] ?? r.required ?? true;
    if (!r.pass && required) failures.push(`${r.name}: ${r.details ?? 'failed'}`);
    if (!r.pass && r.safety) safety_violations.push(...(r.details ?? r.name).split('; '));
  }
  if (run.status === 'error') failures.unshift(`run error: ${run.error}`);
  if (run.status === 'replay_mismatch') failures.unshift(`replay mismatch: ${run.error}`);
  const t = trajectoryOf(run);
  const sim = !!run.meta.simulated;
  return {
    trial: run.trial, run_id: run.run_id, pass: failures.length === 0, status: run.status, scores,
    failures, safety_violations, steps: t.steps, tokens: t.tokens, cost_usd: t.cost_usd,
    latency_ms: t.latency_ms, simulated_latency: sim || undefined,
  };
}

export async function scoreRunset(store: Store, cases: Case[], runs: Run[], o: ScoreOptions): Promise<RunsetResults> {
  const cfg = o.config ?? {};
  const byCase = new Map<string, Run[]>();
  for (const r of runs) byCase.set(r.case_id, [...(byCase.get(r.case_id) ?? []), r]);
  const out: CaseResult[] = [];
  for (const c of cases) {
    const rs = (byCase.get(c.id) ?? []).sort((a, b) => a.trial - b.trial);
    if (!rs.length) continue;
    const trials = [];
    for (const r of rs) trials.push(await scoreRun(c, r, cfg, o.judge));
    out.push({ case_id: c.id, category: c.category, tags: c.tags ?? [], trials });
  }
  const res: RunsetResults = {
    name: o.name, created: new Date().toISOString(), dataset: o.dataset,
    meta: { ...(store.readManifest(o.name) ?? {}), ...(o.meta ?? {}) },
    judge: o.judge ? { model: o.judge.model, temperature: o.judge.temperature } : undefined,
    cases: out,
  };
  void rubricHash;
  store.writeResults(o.name, res);
  return res;
}

/* ---------- aggregation ---------- */

export function caseMetric(c: CaseResult, metric: string): number | null {
  const vals: number[] = [];
  for (const t of c.trials) {
    let v: number | null | undefined;
    switch (metric) {
      case 'task_success': v = t.pass ? 1 : 0; break;
      case 'cost_usd': v = t.cost_usd; break;
      case 'latency_ms': v = t.latency_ms; break;
      case 'tokens': v = t.tokens; break;
      case 'steps': v = t.steps; break;
      case 'failure_rate': v = t.pass ? 0 : 1; break;
      default: v = t.scores[metric];
    }
    if (v !== null && v !== undefined && !Number.isNaN(v)) vals.push(v);
  }
  return vals.length ? mean(vals) : null;
}

export function metricNames(r: RunsetResults): string[] {
  const s = new Set<string>(['task_success', 'cost_usd', 'latency_ms', 'tokens', 'steps']);
  for (const c of r.cases) for (const t of c.trials) for (const [k, v] of Object.entries(t.scores)) if (v !== null) s.add(k);
  return [...s];
}
