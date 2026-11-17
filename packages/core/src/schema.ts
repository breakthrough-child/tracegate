import { Ajv } from 'ajv';
import type { Case, TraceEvent } from './types.js';

const base = {
  v: { const: 1 },
  run_id: { type: 'string', minLength: 1 },
  id: { type: 'string', minLength: 1 },
  parent_id: { type: 'string' },
  ts: { type: 'string' },
  step: { type: 'integer', minimum: 0 },
};
const ev = (type: string, props: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: { ...base, type: { const: type }, ...props },
  required: ['v', 'type', 'run_id', 'id', 'ts', ...required],
});
const usage = {
  type: 'object',
  properties: { input_tokens: { type: 'number' }, output_tokens: { type: 'number' }, cache_read_tokens: { type: 'number' } },
  required: ['input_tokens', 'output_tokens'],
};

export const TRACE_EVENT_SCHEMA = {
  $id: 'https://tracegate.dev/schemas/trace-event.json',
  oneOf: [
    ev('run_start', { case_id: { type: 'string' }, trial: { type: 'integer' }, input: {}, meta: { type: 'object' } }, ['input']),
    ev('model_call', {
      provider: { type: 'string' }, model: { type: 'string' }, params: { type: 'object' }, request: {}, response: {},
      usage, cost_usd: { type: 'number' }, latency_ms: { type: 'number' }, retries: { type: 'integer' }, error: { type: 'string' },
    }, ['provider', 'model', 'request', 'latency_ms']),
    ev('tool_call', { name: { type: 'string' }, args: {}, result: {}, error: { type: 'string' }, duration_ms: { type: 'number' } }, ['name', 'args', 'duration_ms']),
    ev('retrieval', {
      query: { type: 'string' }, k: { type: 'integer' }, latency_ms: { type: 'number' },
      results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, score: { type: 'number' }, text_hash: { type: 'string' }, text: { type: 'string' } }, required: ['id'] } },
    }, ['query', 'results']),
    ev('event', { name: { type: 'string' }, data: {} }, ['name']),
    ev('run_end', { status: { enum: ['ok', 'error', 'replay_mismatch'] }, output: {}, state: {}, error: { type: 'string' }, duration_ms: { type: 'number' } }, ['status', 'duration_ms']),
  ],
};

const matcher = {};
export const CASE_SCHEMA = {
  $id: 'https://tracegate.dev/schemas/case.json',
  type: 'object',
  required: ['id', 'input'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    input: { type: ['string', 'object'] },
    context: {},
    tags: { type: 'array', items: { type: 'string' } },
    category: { type: 'string' },
    labels: { type: 'object', properties: { human: { enum: ['pass', 'fail'] }, note: { type: 'string' } }, additionalProperties: false },
    expected: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, args: { type: 'object', additionalProperties: matcher }, optional: { type: 'boolean' } }, additionalProperties: false } },
        forbidden_tools: { type: 'array', items: { type: 'string' } },
        order: { enum: ['strict', 'any'] },
        max_extra_calls: { type: 'integer', minimum: 0 },
        answer: {
          type: 'object', additionalProperties: false,
          properties: { exact: { type: 'string' }, contains: { type: 'array', items: { type: 'string' } }, not_contains: { type: 'array', items: { type: 'string' } }, regex: { type: 'string' }, json_schema: { type: 'object' }, judge: { type: 'string' } },
        },
        retrieval: { type: 'object', required: ['gold'], additionalProperties: false, properties: { gold: { type: 'array', items: { type: 'string' } }, k: { type: 'integer', minimum: 1 }, gains: { type: 'object' } } },
        citations: { type: 'boolean' },
        outcome: { type: 'string' },
        behavior: { enum: ['answer', 'refuse', 'escalate'] },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const vEvent = ajv.compile(TRACE_EVENT_SCHEMA);
const vCase = ajv.compile(CASE_SCHEMA);

const fmt = (errs: { instancePath: string; message?: string }[] | null | undefined): string[] =>
  (errs ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);

export function validateEvent(e: unknown): string[] {
  return vEvent(e) ? [] : fmt(vEvent.errors).slice(0, 6);
}
export function validateCase(c: unknown): string[] {
  return vCase(c) ? [] : fmt(vCase.errors);
}
export function validateTrace(events: TraceEvent[]): string[] {
  const out: string[] = [];
  events.forEach((e, i) => validateEvent(e).forEach((m) => out.push(`event ${i + 1}: ${m}`)));
  if (!events.some((e) => e.type === 'run_start')) out.push('no run_start event');
  if (!events.some((e) => e.type === 'run_end')) out.push('no run_end event');
  return out;
}
export type { Case };
