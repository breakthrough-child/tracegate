import { describe, expect, it } from 'vitest';
import { buildLabelSheet, calibrateJudge, parseCsv, parseCsvObjects, readLabelSheet, toCsv, type Case, type Run } from '../src/index.js';

const cases: Case[] = ['a', 'b', 'c'].map((id) => ({ id, input: `question, "${id}"` }));
const run = (case_id: string, over: Partial<Run> = {}): Run => ({
  run_id: `r-${case_id}`,
  case_id,
  trial: 0,
  input: '',
  output: `answer ${case_id}\nline two`,
  status: 'ok',
  meta: {},
  duration_ms: 1,
  events: [],
  ...over,
});
const rubrics = { a: 'rubric a', b: 'rubric b', c: 'rubric c' };
const set = (name: string) => ({ name, runs: cases.map((c) => run(c.id)) });

describe('csv', () => {
  it('round-trips quotes, commas, newlines and empty cells', () => {
    const rows = [
      { x: 'a,b', y: 'say "hi"', z: '' },
      { x: 'two\nlines', y: '', z: ' s ' },
    ];
    expect(parseCsvObjects(toCsv(['x', 'y', 'z'], rows))).toEqual(rows);
  });
  it('handles BOM and CRLF, as spreadsheets write them', () => {
    expect(parseCsv('﻿a,b\r\n1,"x\r\ny"\r\n')).toEqual([
      ['a', 'b'],
      ['1', 'x\r\ny'],
    ]);
  });
  it('rejects an unterminated quote', () => expect(() => parseCsv('a,"b')).toThrow(/quoted/));
});

describe('label sheet', () => {
  it('is blind, empty, seeded and limited', () => {
    const one = buildLabelSheet([set('base'), set('worse')], cases, rubrics, { n: 5, seed: 3 });
    expect(one.key).toHaveLength(5);
    expect(one.csv).not.toMatch(/base|worse/);
    expect(parseCsvObjects(one.csv).every((r) => r.human_verdict === '' && r.human_notes === '')).toBe(true);
    expect(buildLabelSheet([set('base'), set('worse')], cases, rubrics, { n: 5, seed: 3 }).csv).toBe(one.csv);
    expect(buildLabelSheet([set('base'), set('worse')], cases, rubrics, { n: 5, seed: 4 }).csv).not.toBe(one.csv);
  });
  it('skips failed runs and cases without a rubric, and says so', () => {
    const s = { name: 'base', runs: [run('a', { status: 'error' }), run('b'), run('c')] };
    const r = buildLabelSheet([s], cases, { a: 'x', b: 'y' });
    expect(r.key.map((k) => k.case_id)).toEqual(['b']);
    expect(r.skipped).toHaveLength(2);
  });
  it('reads verdicts, counts blanks and rejects anything else', () => {
    const { csv } = buildLabelSheet([set('base')], cases, rubrics);
    const rows = parseCsvObjects(csv);
    const fill = (vs: string[]) =>
      toCsv(
        Object.keys(rows[0]),
        rows.map((r, i) => ({ ...r, human_verdict: vs[i] })),
      );
    const ok = readLabelSheet(fill(['PASS', ' fail ', '']));
    expect(ok.items.map((i) => i.human)).toEqual(['pass', 'fail']);
    expect([ok.blank, ok.total]).toEqual([1, 3]);
    expect(() => readLabelSheet(fill(['yes', 'fail', '']))).toThrow(/use pass or fail/);
  });
  it('gives hand-checked agreement and kappa end to end', async () => {
    const human = ['pass', 'pass', 'fail', 'fail'];
    const verdict = ['pass', 'fail', 'fail', 'fail'];
    const csv = toCsv(
      ['item_id', 'question', 'actions', 'answer', 'rubric', 'human_verdict', 'human_notes'],
      human.map((h, i) => ({ item_id: `i${i}`, question: 'q', actions: `did ${i}`, answer: 'a', rubric: 'r', human_verdict: h })),
    );
    const seen: string[] = [];
    let k = 0;
    const rep = await calibrateJudge(
      {
        model: 'stub',
        async complete(_s, user) {
          seen.push(user);
          return JSON.stringify({ verdict: verdict[k++] });
        },
      },
      readLabelSheet(csv).items,
    );
    // po = 3/4; pe = (2/4)(1/4) + (2/4)(3/4) = 0.5; kappa = (0.75 - 0.5) / 0.5 = 0.5
    expect(rep.agreement).toBeCloseTo(0.75);
    expect(rep.kappa).toBeCloseTo(0.5);
    expect(rep.confusion).toEqual({ tp: 1, fp: 0, fn: 1, tn: 2 });
    expect(seen[1]).toContain('did 1');
  });
});
