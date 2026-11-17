import { cohenKappa } from './stats.js';
import { judgeAnswer, pairwise, type Judge, type PairwiseResult } from './scorers/judge.js';

export interface CalibrationItem {
  id: string;
  rubric: string;
  question: string;
  answer: string;
  human: 'pass' | 'fail';
}
export interface CalibrationReport {
  judge: { model: string; temperature: number };
  n: number;
  agreement: number;
  kappa: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  disagreements: { id: string; human: string; judge: string; reasoning: string }[];
  warnings: string[];
}

/** Compare judge verdicts to human labels: percent agreement and Cohen's kappa. */
export async function calibrateJudge(judge: Judge, items: CalibrationItem[]): Promise<CalibrationReport> {
  const humans: string[] = [];
  const judged: string[] = [];
  const disagreements: CalibrationReport['disagreements'] = [];
  for (const it of items) {
    const v = await judgeAnswer(judge, it.rubric, it.question, it.answer);
    const j = v.pass ? 'pass' : 'fail';
    humans.push(it.human);
    judged.push(j);
    if (j !== it.human) disagreements.push({ id: it.id, human: it.human, judge: j, reasoning: v.reasoning });
  }
  const { kappa, agreement } = cohenKappa(humans, judged);
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  humans.forEach((h, i) => {
    if (h === 'pass' && judged[i] === 'pass') c.tp++;
    else if (h === 'fail' && judged[i] === 'pass') c.fp++;
    else if (h === 'pass' && judged[i] === 'fail') c.fn++;
    else c.tn++;
  });
  const warnings: string[] = [];
  if (items.length < 40) warnings.push(`Only ${items.length} labelled items: agreement and kappa are very uncertain (aim for 40+).`);
  if (new Set(humans).size < 2) warnings.push('Human labels contain a single class: kappa is not meaningful.');
  return { judge: { model: judge.model, temperature: judge.temperature }, n: items.length, agreement, kappa, confusion: c, disagreements, warnings };
}

/** Rate of order-dependent verdicts across pairs: a direct measure of position bias. */
export async function positionBias(judge: Judge, pairs: { rubric: string; question: string; a: string; b: string }[]): Promise<{ n: number; inconsistent: number; rate: number; results: PairwiseResult[] }> {
  const results: PairwiseResult[] = [];
  for (const p of pairs) results.push(await pairwise(judge, p.rubric, p.question, p.a, p.b, true));
  const inconsistent = results.filter((r) => r.inconsistent).length;
  return { n: pairs.length, inconsistent, rate: pairs.length ? inconsistent / pairs.length : NaN, results };
}
