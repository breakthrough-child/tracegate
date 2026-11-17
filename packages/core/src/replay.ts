import type { ModelCallEvent, Run, Usage } from './types.js';

export type MatchMode = 'exact' | 'normalized';
export interface MatchOptions {
  mode?: MatchMode;
  /** Dotted paths (array indices as numbers) removed from both sides before comparing, e.g. "system", "messages.0.content". Use "*" segments as wildcards: "messages.*.id". */
  ignore?: string[];
}

function drop(v: unknown, path: string[]): unknown {
  if (!path.length || v === null || typeof v !== 'object') return v;
  const [h, ...rest] = path;
  if (Array.isArray(v)) {
    return v.map((x, i) => (h === '*' || h === String(i) ? (rest.length ? drop(x, rest) : undefined) : x));
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (h === '*' || h === k) {
      if (rest.length) o[k] = drop(x, rest);
    } else o[k] = x;
  }
  return o;
}

function canon(v: unknown, mode: MatchMode): unknown {
  if (typeof v === 'string') return mode === 'normalized' ? v.replace(/\s+/g, ' ').trim() : v;
  if (Array.isArray(v)) return v.map((x) => canon(x, mode));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = canon(x, mode);
    }
    return o;
  }
  return v;
}

export function normalizeRequest(req: unknown, opts: MatchOptions = {}): unknown {
  let r = JSON.parse(JSON.stringify(req ?? null)) as unknown;
  for (const p of opts.ignore ?? []) r = drop(r, p.split('.'));
  return canon(r, opts.mode ?? 'exact');
}

/** Structural diff of two JSON values: list of "path: recorded -> now" lines. */
export function diffJson(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (x: unknown) => x !== null && typeof x === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      diffJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  const s = (x: unknown) => {
    const t = x === undefined ? '(missing)' : JSON.stringify(x);
    return t.length > 160 ? t.slice(0, 157) + '...' : t;
  };
  out.push(`${path || '(root)'}: recorded ${s(a)} -> now ${s(b)}`);
  return out;
}

export class ReplayMismatchError extends Error {
  constructor(
    public readonly callIndex: number,
    public readonly diff: string[],
    message?: string,
  ) {
    super(message ?? `Replay mismatch at model call #${callIndex + 1}:\n  ${diff.join('\n  ')}`);
    this.name = 'ReplayMismatchError';
  }
}

/** Serves recorded model responses, in order, and fails with a diff when the request has drifted. */
export class Cassette {
  private calls: ModelCallEvent[];
  constructor(
    run: Run,
    private match: MatchOptions = {},
  ) {
    this.calls = run.events.filter((e): e is ModelCallEvent => e.type === 'model_call' && !e.error);
  }
  get length(): number {
    return this.calls.length;
  }
  next(
    i: number,
    request: unknown,
    provider: string,
    model: string,
  ): { response: unknown; usage?: Usage; cost_usd?: number; latency_ms: number } {
    const rec = this.calls[i];
    if (!rec) {
      throw new ReplayMismatchError(i, [`the agent made model call #${i + 1} but the recording only has ${this.calls.length}`]);
    }
    const diff: string[] = [];
    if (rec.provider !== provider) diff.push(`provider: recorded ${rec.provider} -> now ${provider}`);
    if (rec.model !== model && !(this.match.ignore ?? []).includes('model')) diff.push(`model: recorded ${rec.model} -> now ${model}`);
    diffJson(normalizeRequest(rec.request, this.match), normalizeRequest(request, this.match), 'request', diff);
    if (diff.length) throw new ReplayMismatchError(i, diff);
    return { response: rec.response, usage: rec.usage, cost_usd: rec.cost_usd, latency_ms: rec.latency_ms };
  }
  /** Called at end of run: the agent must have consumed every recorded call. */
  assertConsumed(used: number): void {
    if (used < this.calls.length) {
      throw new ReplayMismatchError(used, [`the agent stopped after ${used} model calls but the recording has ${this.calls.length}`]);
    }
  }
}
