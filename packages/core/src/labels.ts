import type { CalibrationItem } from './calibrate.js';
import { parseCsvObjects, toCsv } from './csv.js';
import { answerText, customEvents, toolCalls } from './scorers/util.js';
import { rng } from './stats.js';
import type { Case, Run } from './types.js';

export const SHEET_COLUMNS = ['item_id', 'question', 'actions', 'answer', 'rubric', 'human_verdict', 'human_notes'];

export interface SheetKeyEntry {
  item_id: string;
  runset: string;
  case_id: string;
  trial: number;
  run_id: string;
}

/** What the agent did, in one line per action, so a label does not rest on the answer text alone. */
export function actionSummary(run: Run): string {
  const lines = toolCalls(run).map(
    (t) => `${t.name}(${JSON.stringify(t.args)}) -> ${t.error ? `error: ${t.error}` : JSON.stringify(t.result ?? null).slice(0, 300)}`,
  );
  for (const e of customEvents(run)) if (e.name !== 'approval') lines.push(`event: ${e.name}`);
  return lines.length ? lines.join('\n') : '(no tool calls)';
}

/**
 * Build a blind labelling sheet: one row per (run set, case) from trial 0, in a seeded random order, with opaque item ids.
 * The verdict columns are left empty; the key that maps items back to runs is returned separately so the labeller does not see it.
 */
export function buildLabelSheet(
  sets: { name: string; runs: Run[] }[],
  cases: Case[],
  rubrics: Record<string, string>,
  o: { n?: number; seed?: number } = {},
): { csv: string; key: SheetKeyEntry[]; skipped: string[] } {
  const skipped: string[] = [];
  const pool: { c: Case; run: Run; set: string; rubric: string }[] = [];
  for (const s of sets)
    for (const c of cases) {
      const run = s.runs.find((r) => r.case_id === c.id && r.trial === 0);
      const rubric = rubrics[c.id] ?? c.expected?.answer?.judge;
      if (!run) continue;
      if (run.status !== 'ok') skipped.push(`${s.name}/${c.id}: run status ${run.status}`);
      else if (!rubric) skipped.push(`${s.name}/${c.id}: no rubric`);
      else pool.push({ c, run, set: s.name, rubric });
    }
  const r = rng(o.seed ?? 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, o.n ?? pool.length);
  const id = (i: number) => `item-${String(i + 1).padStart(3, '0')}`;
  return {
    csv: toCsv(
      SHEET_COLUMNS,
      picked.map((p, i) => ({
        item_id: id(i),
        question: typeof p.c.input === 'string' ? p.c.input : JSON.stringify(p.c.input),
        actions: actionSummary(p.run),
        answer: answerText(p.run),
        rubric: p.rubric,
        human_verdict: '',
        human_notes: '',
      })),
    ),
    key: picked.map((p, i) => ({ item_id: id(i), runset: p.set, case_id: p.c.id, trial: p.run.trial, run_id: p.run.run_id })),
    skipped,
  };
}

/** Read a completed sheet. Blank verdicts are counted and skipped; anything other than pass/fail is an error. */
export function readLabelSheet(text: string): { items: CalibrationItem[]; blank: number; total: number } {
  const rows = parseCsvObjects(text);
  const missing = SHEET_COLUMNS.filter((c) => c !== 'human_notes' && c !== 'actions' && rows.length && !(c in rows[0]));
  if (!rows.length) throw new Error('The label sheet has no rows');
  if (missing.length) throw new Error(`The label sheet is missing column(s): ${missing.join(', ')}`);
  const items: CalibrationItem[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  let blank = 0;
  for (const r of rows) {
    if (seen.has(r.item_id)) bad.push(`${r.item_id}: duplicate item_id`);
    seen.add(r.item_id);
    const v = r.human_verdict.trim().toLowerCase();
    if (!v) blank++;
    else if (v !== 'pass' && v !== 'fail') bad.push(`${r.item_id}: "${r.human_verdict}" (use pass or fail)`);
    else items.push({ id: r.item_id, rubric: r.rubric, question: r.question, answer: r.answer, context: r.actions || undefined, human: v });
  }
  if (bad.length) throw new Error(`Invalid label(s):\n  ${bad.join('\n  ')}`);
  return { items, blank, total: rows.length };
}
