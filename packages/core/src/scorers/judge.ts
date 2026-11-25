import { createHash } from 'node:crypto';
import { answerText, na, retrievals, type Scorer } from './util.js';

/** Anything that can answer a prompt. Implementations live in adapters (HTTP) and in simulations. */
export interface Judge {
  model: string;
  /** undefined when the provider default is used (current Claude models reject a custom temperature) */
  temperature?: number;
  complete(system: string, user: string): Promise<string>;
}

export const JUDGE_SYSTEM = `You are a strict, consistent evaluator. Apply the rubric exactly. Respond with ONLY a JSON object, no prose.`;

export const rubricHash = (r: string): string => createHash('sha256').update(r).digest('hex').slice(0, 12);

export interface JudgeVerdict {
  pass: boolean;
  reasoning: string;
  raw: string;
}

export function parseJson<T>(raw: string): T | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return undefined;
  }
}

/** Single-answer rubric judging with structured output. Unparseable output counts as a failure, not a pass. */
export async function judgeAnswer(judge: Judge, rubric: string, question: string, answer: string, context?: string): Promise<JudgeVerdict> {
  const user = `RUBRIC:\n${rubric}\n\nQUESTION:\n${question}\n${context ? `\nCONTEXT:\n${context}\n` : ''}\nANSWER:\n${answer}\n\nReturn {"verdict":"pass"|"fail","reasoning":"<one sentence>"}`;
  const raw = await judge.complete(JUDGE_SYSTEM, user);
  const j = parseJson<{ verdict?: string; reasoning?: string }>(raw);
  return { pass: j?.verdict === 'pass', reasoning: j?.reasoning ?? 'unparseable judge output', raw };
}

export type PairWinner = 'A' | 'B' | 'tie';
export interface PairwiseResult {
  winner: PairWinner;
  /** true when the two orderings disagreed (a symptom of position bias) */
  inconsistent: boolean;
  first: PairWinner;
  second: PairWinner;
}

async function pairOnce(judge: Judge, rubric: string, question: string, a: string, b: string): Promise<PairWinner> {
  const user = `RUBRIC:\n${rubric}\n\nQUESTION:\n${question}\n\nANSWER A:\n${a}\n\nANSWER B:\n${b}\n\nWhich answer better satisfies the rubric? Return {"winner":"A"|"B"|"tie","reasoning":"<one sentence>"}`;
  const j = parseJson<{ winner?: string }>(await judge.complete(JUDGE_SYSTEM, user));
  return j?.winner === 'A' || j?.winner === 'B' ? j.winner : 'tie';
}

/**
 * Pairwise judging with position swap: ask with (a,b) and again with (b,a).
 * A win counts only if both orderings agree; otherwise the result is a tie and flagged inconsistent.
 */
export async function pairwise(judge: Judge, rubric: string, question: string, a: string, b: string, swap = true): Promise<PairwiseResult> {
  const first = await pairOnce(judge, rubric, question, a, b);
  if (!swap) return { winner: first, inconsistent: false, first, second: first };
  const rawSecond = await pairOnce(judge, rubric, question, b, a);
  const second: PairWinner = rawSecond === 'A' ? 'B' : rawSecond === 'B' ? 'A' : 'tie';
  if (first === second) return { winner: first, inconsistent: false, first, second };
  return { winner: 'tie', inconsistent: true, first, second };
}

/** LLM-as-judge scorer for semantic answer checks (`expected.answer.judge`) and faithfulness. */
export const judgeScorer: Scorer = {
  name: 'judge',
  async score({ case: c, run, judge, chunkText }) {
    const rubric = c.expected?.answer?.judge;
    if (!rubric) return na('answer_judge');
    if (!judge) return { name: 'answer_judge', score: null, pass: true, details: 'no judge configured (skipped)' };
    const q = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    const ctxText = retrievals(run)
      .flatMap((r) => r.results.map((x) => chunkText(x.id)))
      .filter(Boolean)
      .join('\n---\n');
    const v = await judgeAnswer(judge, rubric, q, answerText(run), ctxText || undefined);
    return { name: 'answer_judge', score: v.pass ? 1 : 0, pass: v.pass, details: v.pass ? undefined : v.reasoning };
  },
};

/** Judge-based faithfulness: are all claims supported by the retrieved context? */
export const faithfulnessScorer: Scorer = {
  name: 'faithfulness',
  async score({ case: c, run, judge, chunkText }) {
    if (!c.expected?.citations && !c.expected?.retrieval) return na('faithfulness');
    if (!judge) return { name: 'faithfulness', score: null, pass: true, details: 'no judge configured (skipped)' };
    const ctxText = retrievals(run)
      .flatMap((r) => r.results.map((x) => chunkText(x.id)))
      .filter(Boolean)
      .join('\n---\n');
    if (!ctxText) return { name: 'faithfulness', score: null, pass: true, details: 'no chunk text available (skipped)' };
    const v = await judgeAnswer(
      judge,
      'Pass only if EVERY factual claim in the answer is supported by the CONTEXT. Fail on any unsupported claim.',
      typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
      answerText(run),
      ctxText,
    );
    return { name: 'faithfulness', score: v.pass ? 1 : 0, pass: v.pass, required: false, details: v.pass ? undefined : v.reasoning };
  },
};
