import { randomBytes } from 'node:crypto';
import { runFromEvents } from './store.js';
import { TRACE_VERSION, type Run, type TraceEvent } from './types.js';

/* Minimal OTLP/JSON mapping using the OpenTelemetry GenAI semantic conventions (gen_ai.*) where they apply. */

type Attr = { key: string; value: Record<string, unknown> };
const attr = (key: string, v: unknown): Attr | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  return { key, value: { stringValue: typeof v === 'string' ? v : JSON.stringify(v) } };
};
const attrs = (o: Record<string, unknown>): Attr[] =>
  Object.entries(o)
    .map(([k, v]) => attr(k, v))
    .filter((x): x is Attr => !!x);
const nano = (ts: string, plusMs = 0): string => String((BigInt(Date.parse(ts)) + BigInt(Math.round(plusMs))) * 1_000_000n);

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status?: { code: number; message?: string };
}

export function runToOtlp(run: Run, serviceName = 'tracegate'): { resourceSpans: unknown[] } {
  const traceId = randomBytes(16).toString('hex');
  const rootId = randomBytes(8).toString('hex');
  const spans: OtlpSpan[] = [];
  const first = run.events[0]?.ts ?? new Date().toISOString();
  spans.push({
    traceId,
    spanId: rootId,
    name: `invoke_agent ${run.meta.agent ?? 'agent'}`,
    kind: 1,
    startTimeUnixNano: nano(first),
    endTimeUnixNano: nano(first, run.duration_ms),
    attributes: attrs({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': run.meta.agent,
      'tracegate.case_id': run.case_id,
      'tracegate.trial': run.trial,
      'tracegate.input': run.input,
      'tracegate.output': run.output,
      'tracegate.run_id': run.run_id,
    }),
    status: run.status === 'ok' ? { code: 1 } : { code: 2, message: run.error },
  });
  for (const e of run.events) {
    const id = randomBytes(8).toString('hex');
    const base = { traceId, spanId: id, parentSpanId: rootId, startTimeUnixNano: nano(e.ts) };
    if (e.type === 'model_call') {
      spans.push({
        ...base,
        name: `chat ${e.model}`,
        kind: 3,
        endTimeUnixNano: nano(e.ts, e.latency_ms),
        attributes: attrs({
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': e.provider,
          'gen_ai.request.model': e.model,
          'gen_ai.request.temperature': (e.params as { temperature?: number } | undefined)?.temperature,
          'gen_ai.usage.input_tokens': e.usage?.input_tokens,
          'gen_ai.usage.output_tokens': e.usage?.output_tokens,
          'tracegate.cost_usd': e.cost_usd,
          'tracegate.request': e.request,
          'tracegate.response': e.response,
        }),
        status: e.error ? { code: 2, message: e.error } : { code: 1 },
      });
    } else if (e.type === 'tool_call') {
      spans.push({
        ...base,
        name: `execute_tool ${e.name}`,
        kind: 1,
        endTimeUnixNano: nano(e.ts, e.duration_ms),
        attributes: attrs({
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': e.name,
          'gen_ai.tool.call.arguments': e.args,
          'gen_ai.tool.call.result': e.result,
        }),
        status: e.error ? { code: 2, message: e.error } : { code: 1 },
      });
    } else if (e.type === 'retrieval') {
      spans.push({
        ...base,
        name: 'retrieval',
        kind: 1,
        endTimeUnixNano: nano(e.ts, e.latency_ms ?? 0),
        attributes: attrs({
          'gen_ai.operation.name': 'retrieval',
          'gen_ai.retrieval.query.text': e.query,
          'tracegate.retrieval.results': e.results,
        }),
      });
    } else if (e.type === 'event') {
      spans.push({
        ...base,
        name: `event ${e.name}`,
        kind: 1,
        endTimeUnixNano: nano(e.ts),
        attributes: attrs({ 'tracegate.event.name': e.name, 'tracegate.event.data': e.data }),
      });
    }
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': serviceName }) },
        scopeSpans: [{ scope: { name: 'tracegate', version: '0.1.0' }, spans }],
      },
    ],
  };
}

export async function postOtlp(endpoint: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const url = endpoint.replace(/\/$/, '') + (endpoint.endsWith('/v1/traces') ? '' : '/v1/traces');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OTLP export failed: ${res.status} ${res.statusText}`);
}

/* ---------- import ---------- */

function val(v: Record<string, unknown> | undefined): unknown {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  return undefined;
}
const maybeJson = (x: unknown): unknown => {
  if (typeof x !== 'string') return x;
  try {
    return JSON.parse(x);
  } catch {
    return x;
  }
};
const iso = (n: string): string => new Date(Number(BigInt(n) / 1_000_000n)).toISOString();
const ms = (s: string, e: string): number => Number((BigInt(e) - BigInt(s)) / 1_000_000n);

/**
 * Import OTLP/JSON (GenAI-convention or OpenInference-style attributes) as Tracegate runs, one per trace id.
 * Unknown spans are skipped. Missing token counts stay undefined rather than being guessed.
 */
export function otlpToRuns(doc: { resourceSpans?: { scopeSpans?: { spans?: Record<string, unknown>[] }[] }[] }): Run[] {
  const byTrace = new Map<string, Record<string, unknown>[]>();
  for (const rs of doc.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? []) {
        const t = sp.traceId as string;
        byTrace.set(t, [...(byTrace.get(t) ?? []), sp]);
      }
  const runs: Run[] = [];
  for (const [traceId, spans] of byTrace) {
    spans.sort((a, b) => Number(BigInt(a.startTimeUnixNano as string) - BigInt(b.startTimeUnixNano as string)));
    const events: TraceEvent[] = [];
    const run_id = traceId;
    let seq = 0;
    let input: unknown,
      output: unknown,
      caseId = traceId,
      status: 'ok' | 'error' = 'ok';
    let first = '',
      last = '';
    for (const sp of spans) {
      const a: Record<string, unknown> = {};
      for (const at of (sp.attributes as Attr[]) ?? []) a[at.key] = val(at.value);
      const start = sp.startTimeUnixNano as string,
        end = sp.endTimeUnixNano as string;
      if (!first) first = start;
      last = end;
      const common = { v: TRACE_VERSION, run_id, id: `e${++seq}`, ts: iso(start) };
      const err =
        (sp.status as { code?: number; message?: string } | undefined)?.code === 2
          ? ((sp.status as { message?: string }).message ?? 'error')
          : undefined;
      const oi = a['openinference.span.kind'] as string | undefined;
      const op = (a['gen_ai.operation.name'] as string | undefined) ?? (oi ? oi.toLowerCase() : undefined);
      if (op === 'invoke_agent' || op === 'agent' || oi === 'AGENT' || (oi === 'CHAIN' && !sp.parentSpanId)) {
        input = maybeJson(a['tracegate.input'] ?? a['input.value']);
        output = maybeJson(a['tracegate.output'] ?? a['output.value']);
        caseId = (a['tracegate.case_id'] as string) ?? caseId;
        if (err) status = 'error';
      } else if (op === 'chat' || op === 'text_completion' || op === 'llm') {
        const inTok = (a['gen_ai.usage.input_tokens'] ?? a['llm.token_count.prompt']) as number | undefined;
        const outTok = (a['gen_ai.usage.output_tokens'] ?? a['llm.token_count.completion']) as number | undefined;
        events.push({
          ...common,
          type: 'model_call',
          provider: String(a['gen_ai.system'] ?? a['llm.provider'] ?? 'unknown'),
          model: String(a['gen_ai.request.model'] ?? a['llm.model_name'] ?? 'unknown'),
          request: maybeJson(a['tracegate.request'] ?? a['input.value']),
          response: maybeJson(a['tracegate.response'] ?? a['output.value']),
          usage: inTok !== undefined && outTok !== undefined ? { input_tokens: inTok, output_tokens: outTok } : undefined,
          cost_usd: a['tracegate.cost_usd'] as number | undefined,
          latency_ms: ms(start, end),
          error: err,
        });
      } else if (op === 'execute_tool' || op === 'tool') {
        events.push({
          ...common,
          type: 'tool_call',
          name: String(a['gen_ai.tool.name'] ?? a['tool.name'] ?? sp.name),
          args: maybeJson(a['gen_ai.tool.call.arguments'] ?? a['tool.parameters'] ?? a['input.value']) ?? {},
          result: maybeJson(a['gen_ai.tool.call.result'] ?? a['output.value']),
          error: err,
          duration_ms: ms(start, end),
        });
      } else if (op === 'retrieval' || op === 'retriever') {
        let results = maybeJson(a['tracegate.retrieval.results']) as { id: string; score?: number }[] | undefined;
        if (!results) {
          results = [];
          for (let i = 0; a[`retrieval.documents.${i}.document.id`] !== undefined; i++) {
            results.push({
              id: String(a[`retrieval.documents.${i}.document.id`]),
              score: a[`retrieval.documents.${i}.document.score`] as number | undefined,
            });
          }
        }
        events.push({
          ...common,
          type: 'retrieval',
          query: String(a['gen_ai.retrieval.query.text'] ?? a['input.value'] ?? ''),
          results,
          latency_ms: ms(start, end),
        });
      }
    }
    if (!events.length && input === undefined) continue;
    const startEv: TraceEvent = {
      v: TRACE_VERSION,
      run_id,
      id: 'e0',
      ts: iso(first),
      type: 'run_start',
      case_id: caseId,
      trial: 0,
      input: input ?? null,
      meta: { imported: 'otlp' },
    };
    const endEv: TraceEvent = {
      v: TRACE_VERSION,
      run_id,
      id: `e${seq + 1}`,
      ts: iso(last),
      type: 'run_end',
      status,
      output,
      duration_ms: ms(first, last),
    };
    runs.push(runFromEvents([startEv, ...events, endEv]));
  }
  return runs;
}
