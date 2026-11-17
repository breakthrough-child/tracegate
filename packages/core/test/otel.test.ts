import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { otlpToRuns, runToOtlp, scoreRun, type Case } from '../src/index.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

describe('OpenTelemetry interop (file fixtures, no collector)', () => {
  it('imports GenAI-convention spans as a run and scores it', async () => {
    const [run] = otlpToRuns(fx('genai.otlp.json'));
    expect(run.case_id).toBe('otel-1');
    expect(run.output).toBe('It is shipped.');
    const types = run.events.map((e) => e.type);
    expect(types).toEqual(['run_start', 'model_call', 'tool_call', 'run_end']);
    const mc = run.events[1] as { usage: { input_tokens: number }; latency_ms: number };
    expect(mc.usage.input_tokens).toBe(120);
    expect(mc.latency_ms).toBe(500);
    const c: Case = {
      id: 'otel-1',
      input: 'x',
      expected: { tools: [{ name: 'lookup_order', args: { order_id: 'ORD-1001' } }], answer: { contains: ['shipped'] } },
    };
    const r = await scoreRun(c, run, {});
    expect(r.pass).toBe(true);
    expect(r.tokens).toBe(150);
  });
  it('imports OpenInference-style retriever and LLM spans', () => {
    const [run] = otlpToRuns(fx('openinference.otlp.json'));
    const retr = run.events.find((e) => e.type === 'retrieval') as { results: { id: string; score?: number }[] };
    expect(retr.results.map((r) => r.id)).toEqual(['kb-returns', 'kb-shipping']);
    expect(retr.results[0].score).toBe(0.91);
    expect(run.output).toBe('30 days [kb-returns]');
  });
  it('export then import round-trips the essentials', () => {
    const [run] = otlpToRuns(fx('genai.otlp.json'));
    const doc = runToOtlp(run) as { resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string }[] }[] }[] }[] };
    const spans = doc.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s) => s.name)).toEqual(['invoke_agent agent', 'chat claude-sonnet-4', 'execute_tool lookup_order']);
    expect(spans[1].attributes.some((a) => a.key === 'gen_ai.usage.input_tokens')).toBe(true);
    const [back] = otlpToRuns(doc as never);
    expect(back.case_id).toBe('otel-1');
    expect(back.events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });
});
