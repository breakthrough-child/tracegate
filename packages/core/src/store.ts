import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Run, RunEndEvent, RunStartEvent, RunsetResults, TraceEvent } from './types.js';

export const DEFAULT_DIR = '.tracegate';

export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export interface Manifest {
  name: string;
  created: string;
  dataset?: string;
  label?: string;
  mode?: 'live' | 'replay' | 'record';
  trials?: number;
  git_sha?: string;
  simulated?: boolean;
  [k: string]: unknown;
}

export class Store {
  constructor(public readonly dir: string = DEFAULT_DIR) {}
  runsetDir(name: string): string {
    return join(this.dir, 'runs', safeName(name));
  }
  listRunsets(): string[] {
    const d = join(this.dir, 'runs');
    return existsSync(d) ? readdirSync(d).sort() : [];
  }
  writeManifest(name: string, m: Manifest): void {
    mkdirSync(this.runsetDir(name), { recursive: true });
    writeFileSync(join(this.runsetDir(name), 'manifest.json'), JSON.stringify(m, null, 2));
  }
  readManifest(name: string): Manifest | undefined {
    const f = join(this.runsetDir(name), 'manifest.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Manifest) : undefined;
  }
  runFile(name: string, caseId: string, trial: number): string {
    return join(this.runsetDir(name), `${safeName(caseId)}__t${trial}.jsonl`);
  }
  appendEvent(file: string, ev: TraceEvent): void {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, JSON.stringify(ev) + '\n');
  }
  loadRuns(name: string): Run[] {
    const d = this.runsetDir(name);
    if (!existsSync(d)) throw new Error(`Run set not found: ${name} (looked in ${d})`);
    return readdirSync(d)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => readRunFile(join(d, f)));
  }
  writeResults(name: string, r: RunsetResults): void {
    mkdirSync(this.runsetDir(name), { recursive: true });
    writeFileSync(join(this.runsetDir(name), 'results.json'), JSON.stringify(r, null, 2));
  }
  readResults(name: string): RunsetResults | undefined {
    const f = join(this.runsetDir(name), 'results.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RunsetResults) : undefined;
  }
}

export function parseJsonl(text: string): TraceEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as TraceEvent;
      } catch {
        throw new Error(`Invalid JSON on line ${i + 1}`);
      }
    });
}

export function runFromEvents(events: TraceEvent[], fallbackId = 'unknown'): Run {
  const start = events.find((e): e is RunStartEvent => e.type === 'run_start');
  const end = [...events].reverse().find((e): e is RunEndEvent => e.type === 'run_end');
  const run_id = start?.run_id ?? events[0]?.run_id ?? fallbackId;
  return {
    run_id,
    case_id: start?.case_id ?? fallbackId,
    trial: start?.trial ?? 0,
    input: start?.input,
    output: end?.output,
    state: end?.state,
    status: end?.status ?? 'error',
    error: end?.error ?? (end ? undefined : 'run_end event missing (truncated trace?)'),
    meta: start?.meta ?? {},
    duration_ms: end?.duration_ms ?? 0,
    events,
  };
}

export function readRunFile(file: string): Run {
  return runFromEvents(parseJsonl(readFileSync(file, 'utf8')), basename(file, '.jsonl'));
}

/** Resolve a run set by name under the store dir, or by a direct path to a directory. */
export function resolveRunset(store: Store, nameOrPath: string): string {
  if (existsSync(store.runsetDir(nameOrPath))) return nameOrPath;
  if (existsSync(join(nameOrPath, 'results.json')) || existsSync(join(nameOrPath, 'manifest.json'))) return nameOrPath;
  throw new Error(`Unknown run set "${nameOrPath}". Known: ${store.listRunsets().join(', ') || '(none)'}`);
}
