import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { costOf, DEFAULT_PRICES, type PriceTable } from './pricing.js';
import { makeRedactor, type RedactionRules } from './redact.js';
import { TRACE_VERSION } from './types.js';
import type { Case, RetrievedItem, RunMeta, TraceEvent, Usage } from './types.js';
import type { Cassette } from './replay.js';

export type Sink = (ev: TraceEvent) => void;

export interface RecorderOptions {
  case: Case;
  trial: number;
  mode: 'live' | 'replay';
  meta?: RunMeta;
  sink: Sink;
  prices?: PriceTable;
  redaction?: RedactionRules;
  cassette?: Cassette;
  /** Include retrieved chunk text on disk (default false: only hashes). */
  storeChunkText?: boolean;
}

export interface ModelCallOptions<Res> {
  provider: string;
  model: string;
  request: unknown;
  params?: Record<string, unknown>;
  usage?: (res: Res) => Usage | undefined;
  /** Retries on thrown errors (default 0). Retries are counted in the trace. */
  retries?: number;
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The context handed to an agent. Everything an agent does that matters for evaluation
 * (model calls, tool calls, retrievals, custom events) goes through it.
 */
export class AgentContext {
  readonly runId = randomUUID();
  readonly case: Case;
  readonly trial: number;
  readonly mode: 'live' | 'replay';
  private step = -1;
  private seq = 0;
  private startMs = Date.now();
  private state: unknown;
  private redact: <T>(v: T) => T;
  private prices: PriceTable;
  private modelIdx = 0;

  constructor(private o: RecorderOptions) {
    this.case = o.case;
    this.trial = o.trial;
    this.mode = o.mode;
    this.redact = makeRedactor(o.redaction);
    this.prices = o.prices ?? DEFAULT_PRICES;
  }

  private emit<T extends Omit<TraceEvent, 'v' | 'run_id' | 'id' | 'ts'>>(ev: T, idHint?: string): string {
    const id = idHint ?? `e${++this.seq}`;
    const full = { v: TRACE_VERSION, run_id: this.runId, id, ts: new Date().toISOString(), ...ev } as unknown as TraceEvent;
    if (full.type !== 'run_start' && full.type !== 'run_end') full.step = Math.max(this.step, 0);
    this.o.sink(this.redact(full));
    return id;
  }

  get modelCallsUsed(): number {
    return this.modelIdx;
  }

  start(input: unknown): void {
    this.emit({ type: 'run_start', case_id: this.case.id, trial: this.trial, input, meta: this.o.meta });
  }
  end(r: { status: 'ok' | 'error' | 'replay_mismatch'; output?: unknown; error?: string }): void {
    this.emit({ type: 'run_end', status: r.status, output: r.output, state: this.state, error: r.error, duration_ms: Date.now() - this.startMs });
  }

  /** Snapshot the resulting state (database rows, created tickets) for outcome scorers. */
  setState(state: unknown): void {
    this.state = state;
  }
  /** Record a custom event, e.g. "approval", "escalation", "refusal". */
  event(name: string, data?: unknown): void {
    this.emit({ type: 'event', name, data });
  }

  /** Record (live) or serve (replay) one model call. Adapters build on this. */
  async model<Res>(opts: ModelCallOptions<Res>, live: () => Promise<Res>): Promise<Res> {
    this.step++;
    const t0 = Date.now();
    if (this.mode === 'replay') {
      const rec = this.o.cassette;
      if (!rec) throw new Error('replay mode without a cassette');
      const call = rec.next(this.modelIdx++, opts.request, opts.provider, opts.model);
      this.emit({
        type: 'model_call', provider: opts.provider, model: opts.model, params: opts.params, request: opts.request,
        response: call.response, usage: call.usage, cost_usd: call.cost_usd, latency_ms: call.latency_ms,
      });
      return structuredClone(call.response) as Res;
    }
    let retries = 0;
    for (;;) {
      try {
        const res = await live();
        const usage = opts.usage?.(res);
        const sim = (res as { __latency_ms?: number } | null)?.__latency_ms;
        this.emit({
          type: 'model_call', provider: opts.provider, model: opts.model, params: opts.params, request: opts.request,
          response: res, usage, cost_usd: costOf(this.prices, opts.model, usage),
          latency_ms: sim ?? Date.now() - t0, retries: retries || undefined,
        });
        return res;
      } catch (err) {
        if (retries < (opts.retries ?? 0)) {
          retries++;
          continue;
        }
        this.emit({
          type: 'model_call', provider: opts.provider, model: opts.model, params: opts.params, request: opts.request,
          latency_ms: Date.now() - t0, retries: retries || undefined, error: String((err as Error)?.message ?? err),
        });
        throw err;
      }
    }
  }

  /** Execute and record a tool call. Tools always run for real (also in replay) so tool code is tested. */
  async tool<A, R>(name: string, args: A, fn: (args: A) => Promise<R> | R): Promise<R> {
    const t0 = Date.now();
    try {
      const result = await fn(args);
      const sim = (result as { __latency_ms?: number } | null)?.__latency_ms;
      this.emit({ type: 'tool_call', name, args, result, duration_ms: sim ?? Date.now() - t0 });
      return result;
    } catch (err) {
      this.emit({ type: 'tool_call', name, args, error: String((err as Error)?.message ?? err), duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  /** Record a retrieval step. Chunk text is hashed; stored only when storeChunkText is set. */
  async retrieval(query: string, fn: () => Promise<RetrievedItem[]> | RetrievedItem[], k?: number): Promise<RetrievedItem[]> {
    const t0 = Date.now();
    const results = await fn();
    this.emit({
      type: 'retrieval', query, k: k ?? results.length, latency_ms: Date.now() - t0,
      results: results.map((r) => ({
        id: r.id, score: r.score,
        text_hash: r.text_hash ?? (r.text !== undefined ? sha(r.text) : undefined),
        text: this.o.storeChunkText ? r.text : undefined,
      })),
    });
    return results;
  }
}
