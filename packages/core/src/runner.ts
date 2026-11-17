import { mkdirSync, rmSync } from 'node:fs';
import { AgentContext } from './recorder.js';
import { Cassette, ReplayMismatchError, type MatchOptions } from './replay.js';
import type { Store } from './store.js';
import type { PriceTable } from './pricing.js';
import type { RedactionRules } from './redact.js';
import type { Case, RunMeta } from './types.js';

export type Agent = (input: Case['input'], tg: AgentContext) => Promise<unknown> | unknown;

export interface RunOptions {
  cases: Case[];
  agent: Agent;
  store: Store;
  name: string;
  trials?: number;
  mode?: 'live' | 'replay';
  /** run set to replay from (strict replay) */
  cassette?: string;
  match?: MatchOptions;
  meta?: RunMeta;
  prices?: PriceTable;
  redaction?: RedactionRules;
  concurrency?: number;
  storeChunkText?: boolean;
  dataset?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function runDataset(o: RunOptions): Promise<{ runs: number; mismatches: number; errors: number }> {
  const trials = o.trials ?? 1;
  const mode = o.mode ?? 'live';
  const jobs = o.cases.flatMap((c) => Array.from({ length: trials }, (_, t) => ({ c, t })));
  rmSync(o.store.runsetDir(o.name), { recursive: true, force: true });
  mkdirSync(o.store.runsetDir(o.name), { recursive: true });
  o.store.writeManifest(o.name, {
    name: o.name,
    created: new Date().toISOString(),
    dataset: o.dataset,
    mode,
    trials,
    git_sha: o.meta?.git_sha,
    simulated: o.meta?.simulated,
    cassette: o.cassette,
    meta: o.meta as Record<string, unknown>,
  });
  const cassetteRuns = new Map<string, import('./types.js').Run[]>();
  if (mode === 'replay') {
    if (!o.cassette) throw new Error('replay mode needs a cassette run set');
    for (const r of o.store.loadRuns(o.cassette)) {
      const list = cassetteRuns.get(r.case_id) ?? [];
      list[r.trial] = r;
      cassetteRuns.set(r.case_id, list);
    }
  }
  let done = 0;
  let mismatches = 0;
  let errors = 0;
  const work = async ({ c, t }: { c: Case; t: number }) => {
    const file = o.store.runFile(o.name, c.id, t);
    let cassette: Cassette | undefined;
    if (mode === 'replay') {
      const list = (cassetteRuns.get(c.id) ?? []).filter(Boolean);
      const rec = list[t] ?? list[t % Math.max(list.length, 1)];
      if (!rec) throw new Error(`No recorded run for case "${c.id}" in cassette "${o.cassette}"`);
      cassette = new Cassette(rec, o.match);
    }
    const tg = new AgentContext({
      case: c,
      trial: t,
      mode,
      meta: o.meta,
      prices: o.prices,
      redaction: o.redaction,
      cassette,
      storeChunkText: o.storeChunkText,
      sink: (ev) => o.store.appendEvent(file, ev),
    });
    tg.start(c.input);
    try {
      const output = await o.agent(c.input, tg);
      cassette?.assertConsumed(tg.modelCallsUsed);
      tg.end({ status: 'ok', output });
    } catch (err) {
      if (err instanceof ReplayMismatchError) {
        mismatches++;
        tg.end({ status: 'replay_mismatch', error: err.message });
      } else {
        errors++;
        tg.end({ status: 'error', error: String((err as Error)?.message ?? err) });
      }
    }
    o.onProgress?.(++done, jobs.length);
  };
  const conc = Math.max(1, o.concurrency ?? 4);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, jobs.length) }, async () => {
      while (next < jobs.length) await work(jobs[next++]);
    }),
  );
  return { runs: jobs.length, mismatches, errors };
}
