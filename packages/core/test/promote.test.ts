import { describe, expect, it } from 'vitest';
import { promoteRun, runFromEvents, sampleRuns, TRACE_VERSION, type TraceEvent } from '../src/index.js';

const run = runFromEvents([
  {
    v: TRACE_VERSION,
    run_id: 'abcdef12',
    id: 'e1',
    ts: '2025-01-01T00:00:00Z',
    type: 'run_start',
    case_id: 'x',
    trial: 0,
    input: 'Refund ORD-1 for jo@x.com',
  },
  {
    v: TRACE_VERSION,
    run_id: 'abcdef12',
    id: 'e2',
    ts: '2025-01-01T00:00:01Z',
    type: 'tool_call',
    name: 'refund',
    args: { order_id: 'ORD-1', email: 'jo@x.com' },
    duration_ms: 1,
  },
  {
    v: TRACE_VERSION,
    run_id: 'abcdef12',
    id: 'e3',
    ts: '2025-01-01T00:00:02Z',
    type: 'run_end',
    status: 'ok',
    output: 'done',
    duration_ms: 2,
  },
] as TraceEvent[]);

describe('promote and sample', () => {
  it('promotes with redaction and stated expectations', () => {
    const c = promoteRun(run, { expectSame: true, forbidTools: ['delete'] });
    expect(JSON.stringify(c)).not.toContain('jo@x.com');
    expect(c.expected?.tools?.[0].name).toBe('refund');
    expect(c.tags).toContain('promoted');
    expect(c.id).toBe('promoted-abcdef12');
  });
  it('refuses to promote without stated expectations', () => {
    expect(() => promoteRun(run, {})).toThrow(/expected behaviour/);
  });
  it('sampling is seeded and without replacement', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = sampleRuns(items, 5, 4);
    expect(a).toEqual(sampleRuns(items, 5, 4));
    expect(new Set(a).size).toBe(5);
  });
});
