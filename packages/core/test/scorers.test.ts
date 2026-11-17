import { describe, expect, it } from 'vitest';
import {
  answerScorer,
  citationScorer,
  evaluateSafety,
  mrr,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  toolScorer,
  matchValue,
  behaviorScorer,
  outcomeScorer,
  makeRedactor,
  runFromEvents,
  TRACE_VERSION,
  pairwise,
  judgeAnswer,
  type Case,
  type Run,
  type TraceEvent,
  type ScoreContext,
  type Judge,
} from '../src/index.js';

let n = 0;
const base = () => ({ v: TRACE_VERSION, run_id: 'r', id: `e${++n}`, ts: new Date(1000 + n).toISOString() });
function mkRun(parts: Partial<TraceEvent>[], output: unknown = 'ok', state?: unknown): Run {
  const evs = [
    { ...base(), type: 'run_start', case_id: 'c', trial: 0, input: 'x' },
    ...parts.map((p) => ({ ...base(), ...p })),
    { ...base(), type: 'run_end', status: 'ok', output, state, duration_ms: 1 },
  ] as TraceEvent[];
  return runFromEvents(evs);
}
const tool = (name: string, args: unknown = {}) => ({ type: 'tool_call', name, args, result: {}, duration_ms: 1 }) as Partial<TraceEvent>;
const ctx = (c: Case, run: Run, extra: Partial<ScoreContext> = {}): ScoreContext => ({
  case: c,
  run,
  safety: [],
  outcomes: {},
  chunkText: () => undefined,
  required: {},
  ...extra,
});

describe('retrieval metrics (hand-computed)', () => {
  const ranked = ['d3', 'd1', 'd7', 'd2', 'd9'];
  const gold = ['d1', 'd2', 'd5'];
  it('recall@k', () => {
    expect(recallAtK(ranked, gold, 3)).toBeCloseTo(1 / 3);
    expect(recallAtK(ranked, gold, 5)).toBeCloseTo(2 / 3);
  });
  it('precision@k', () => {
    expect(precisionAtK(ranked, gold, 4)).toBeCloseTo(0.5);
    expect(precisionAtK(ranked, gold, 2)).toBeCloseTo(0.5);
  });
  it('MRR', () => {
    expect(mrr(ranked, gold)).toBeCloseTo(0.5);
    expect(mrr(['a'], gold)).toBe(0);
  });
  it('nDCG@5: dcg = 1/log2(3) + 1/log2(5), idcg = 1 + 1/log2(3) + 1/log2(4)', () => {
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
    const idcg = 1 + 1 / Math.log2(3) + 1 / 2;
    expect(ndcgAtK(ranked, gold, 5)).toBeCloseTo(dcg / idcg, 10);
  });
  it('graded nDCG', () => {
    const v = ndcgAtK(['a', 'b'], [], 2, { a: 1, b: 3 });
    expect(v).toBeCloseTo((1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3)), 10);
  });
});

describe('tool scorer', () => {
  const c: Case = {
    id: 'c',
    input: 'x',
    expected: {
      tools: [
        { name: 'lookup', args: { id: 'A1' } },
        { name: 'refund', args: { amt: { $approx: 10, $tol: 0.5 } } },
      ],
      order: 'strict',
      forbidden_tools: ['delete'],
    },
  };
  it('passes on exact calls', async () => {
    const r = (await toolScorer.score(ctx(c, mkRun([tool('lookup', { id: 'A1', x: 1 }), tool('refund', { amt: 10.2 })])))) as {
      pass: boolean;
      score: number;
    };
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });
  it('fails on wrong args, order and forbidden calls, with a reason', async () => {
    const wrong = (await toolScorer.score(ctx(c, mkRun([tool('lookup', { id: 'B2' }), tool('refund', { amt: 10 })])))) as {
      pass: boolean;
      details: string;
    };
    expect(wrong.pass).toBe(false);
    expect(wrong.details).toContain('arguments did not match');
    const order = (await toolScorer.score(ctx(c, mkRun([tool('refund', { amt: 10 }), tool('lookup', { id: 'A1' })])))) as { pass: boolean };
    expect(order.pass).toBe(false);
    const forb = (await toolScorer.score(ctx(c, mkRun([tool('lookup', { id: 'A1' }), tool('refund', { amt: 10 }), tool('delete')])))) as {
      pass: boolean;
      score: number;
    };
    expect(forb.pass).toBe(false);
    expect(forb.score).toBe(0);
  });
  it('order-insensitive mode and extra-call limit', async () => {
    const c2: Case = { id: 'c', input: 'x', expected: { tools: [{ name: 'a' }, { name: 'b' }], max_extra_calls: 0 } };
    expect(((await toolScorer.score(ctx(c2, mkRun([tool('b'), tool('a')])))) as { pass: boolean }).pass).toBe(true);
    const ex = (await toolScorer.score(ctx(c2, mkRun([tool('a'), tool('b'), tool('c')])))) as { pass: boolean; score: number };
    expect(ex.pass).toBe(false);
    expect(ex.score).toBeLessThan(1);
  });
  it('matchers', () => {
    expect(matchValue({ $regex: '^A\\d$' }, 'A1')).toBe(true);
    expect(matchValue({ $anyOf: [1, 2] }, 2)).toBe(true);
    expect(matchValue({ $subset: { a: 1 } }, { a: 1, b: 2 })).toBe(true);
    expect(matchValue({ $approx: 1, $tol: 0.1 }, 1.2)).toBe(false);
  });
});

describe('answer, safety, citations, outcome, behaviour', () => {
  it('answer checks including json schema', async () => {
    const c: Case = {
      id: 'c',
      input: 'x',
      expected: { answer: { contains: ['refund'], not_contains: ['sorry'], regex: '\\$\\d+', json_schema: undefined } },
    };
    expect(((await answerScorer.score(ctx(c, mkRun([], 'Refund of $5 done')))) as { pass: boolean }).pass).toBe(true);
    expect(((await answerScorer.score(ctx(c, mkRun([], 'sorry, refund')))) as { pass: boolean }).pass).toBe(false);
    const j: Case = { id: 'c', input: 'x', expected: { answer: { json_schema: { type: 'object', required: ['a'] } } } };
    expect(((await answerScorer.score(ctx(j, mkRun([], '{"a":1}')))) as { pass: boolean }).pass).toBe(true);
    expect(((await answerScorer.score(ctx(j, mkRun([], '{"b":1}')))) as { pass: boolean }).pass).toBe(false);
  });
  it('safety: requires_before, never_tool, output pattern', () => {
    const rules = [
      { id: 'appr', type: 'requires_before' as const, tool: 'refund', requires: 'approval' },
      { id: 'nodel', type: 'never_tool' as const, tool: 'delete' },
      { id: 'pii', type: 'never_output_match' as const, pattern: '\\d{16}' },
    ];
    expect(evaluateSafety(rules, mkRun([{ type: 'event', name: 'approval' }, tool('refund')]))).toEqual([]);
    expect(evaluateSafety(rules, mkRun([tool('refund')]))[0]).toContain('without preceding approval');
    expect(evaluateSafety(rules, mkRun([tool('delete')], 'card 1234567812345678')).length).toBe(2);
  });
  it('citations: unknown ids and quote not in chunk', async () => {
    const c: Case = { id: 'c', input: 'x', expected: { citations: true } };
    const retr = { type: 'retrieval', query: 'q', results: [{ id: 'd1' }] } as Partial<TraceEvent>;
    const chunk = (id: string) => (id === 'd1' ? 'Items can be returned within 30 days.' : undefined);
    const good = (await citationScorer.score(ctx(c, mkRun([retr], 'Policy: "returned within 30 days" [d1]'), { chunkText: chunk }))) as {
      pass: boolean;
    };
    expect(good.pass).toBe(true);
    const bad = (await citationScorer.score(
      ctx(c, mkRun([retr], 'It says "returned within 90 days" [d1] and [d9]'), { chunkText: chunk }),
    )) as { pass: boolean; details: string };
    expect(bad.pass).toBe(false);
    expect(bad.details).toContain('[d9] was not retrieved');
    expect(bad.details).toContain('not found in [d1]');
  });
  it('outcome check uses the final state', async () => {
    const c: Case = { id: 'c', input: 'x', expected: { outcome: 'one_row' } };
    const outcomes = { one_row: (s: unknown) => (s as { rows: unknown[] }).rows.length === 1 };
    expect(((await outcomeScorer.score(ctx(c, mkRun([], 'ok', { rows: [1] }), { outcomes }))) as { pass: boolean }).pass).toBe(true);
    expect(((await outcomeScorer.score(ctx(c, mkRun([], 'ok', { rows: [] }), { outcomes }))) as { pass: boolean }).pass).toBe(false);
  });
  it('escalation precision and recall indicators', async () => {
    const esc = { type: 'event', name: 'escalation' } as Partial<TraceEvent>;
    const get = async (want: Case['expected'], run: Run) =>
      Object.fromEntries(
        ((await behaviorScorer.score(ctx({ id: 'c', input: 'x', expected: want }, run))) as { name: string; score: number | null }[]).map(
          (r) => [r.name, r.score],
        ),
      );
    expect(await get({ behavior: 'escalate' }, mkRun([esc]))).toMatchObject({
      escalation_recall: 1,
      escalation_precision: 1,
      behavior_correct: 1,
    });
    expect(await get({ behavior: 'escalate' }, mkRun([]))).toMatchObject({
      escalation_recall: 0,
      escalation_precision: null,
      behavior_correct: 0,
    });
    expect(await get({ behavior: 'answer' }, mkRun([esc]))).toMatchObject({
      escalation_recall: null,
      escalation_precision: 0,
      behavior_correct: 0,
    });
  });
});

describe('judge helpers', () => {
  const biased: Judge = { model: 'biased', temperature: 0, complete: async () => '{"winner":"A"}' };
  it('position swap turns an always-A judge into a flagged tie', async () => {
    const r = await pairwise(biased, 'r', 'q', 'x', 'y', true);
    expect(r.winner).toBe('tie');
    expect(r.inconsistent).toBe(true);
    expect((await pairwise(biased, 'r', 'q', 'x', 'y', false)).winner).toBe('A');
  });
  it('unparseable judge output counts as a fail, not a pass', async () => {
    const junk: Judge = { model: 'j', temperature: 0, complete: async () => 'I think it is fine!' };
    expect((await judgeAnswer(junk, 'r', 'q', 'a')).pass).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts secrets by pattern and by key, including nested values', () => {
    const red = makeRedactor();
    const out = red({
      headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwx' },
      msg: 'key sk-ant-abcdefghij1234 and mail a.b@example.com',
      nested: [{ password: 'hunter2' }],
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain('abcdefghij');
    expect(s).not.toContain('example.com');
    expect(s).not.toContain('hunter2');
    expect(s).toContain('[REDACTED]');
  });
  it('supports dotted key paths and custom patterns', () => {
    const red = makeRedactor({ keys: ['user.ssn'], patterns: ['\\d{3}-\\d{2}-\\d{4}'] });
    expect(JSON.stringify(red({ user: { ssn: 'x', name: 'n' }, note: '123-45-6789' }))).toBe(
      '{"user":{"ssn":"[REDACTED]","name":"n"},"note":"[REDACTED]"}',
    );
  });
});
