import type { Matcher, ModelCallEvent, RetrievalEvent, Run, ToolCallEvent, CustomEvent, Case, ScorerResult } from '../types.js';
import type { Judge } from './judge.js';

export interface SafetyRule {
  id: string;
  type: 'requires_before' | 'never_tool' | 'never_output_match' | 'never_tool_arg_match' | 'max_tool_calls';
  /** requires_before: the action that needs a precondition. never_tool/never_tool_arg_match/max_tool_calls: the tool. */
  tool?: string;
  /** requires_before: the precondition, an event name or a tool name that must occur earlier in the run. */
  requires?: string;
  pattern?: string;
  /** never_tool_arg_match: dotted path into the tool arguments. Defaults to the whole argument object. */
  path?: string;
  max?: number;
}

export interface ScoreContext {
  case: Case;
  run: Run;
  judge?: Judge;
  safety: SafetyRule[];
  outcomes: Record<string, (state: unknown, run: Run, c: Case) => boolean | Promise<boolean>>;
  /** Resolves chunk text by id for groundedness checks (from the corpus, case context or stored retrieval text). */
  chunkText: (id: string) => string | undefined;
  /** Run-level override of which scorer failures are fatal. */
  required: Record<string, boolean>;
}

export interface Scorer {
  name: string;
  /** Return null score when the scorer does not apply to this case. */
  score(ctx: ScoreContext): ScorerResult | ScorerResult[] | Promise<ScorerResult | ScorerResult[]>;
}

export const toolCalls = (run: Run): ToolCallEvent[] => run.events.filter((e): e is ToolCallEvent => e.type === 'tool_call');
export const modelCalls = (run: Run): ModelCallEvent[] => run.events.filter((e): e is ModelCallEvent => e.type === 'model_call');
export const retrievals = (run: Run): RetrievalEvent[] => run.events.filter((e): e is RetrievalEvent => e.type === 'retrieval');
export const customEvents = (run: Run, name?: string): CustomEvent[] =>
  run.events.filter((e): e is CustomEvent => e.type === 'event' && (!name || e.name === name));

export const answerText = (run: Run): string =>
  typeof run.output === 'string' ? run.output : run.output === undefined || run.output === null ? '' : JSON.stringify(run.output);

export const na = (name: string): ScorerResult => ({ name, score: null, pass: true });

/** Matches an actual value against a matcher: exact, $regex, $approx, $anyOf, $subset, $exists. */
export function matchValue(m: Matcher, actual: unknown): boolean {
  if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
    const o = m as Record<string, unknown>;
    if ('$regex' in o) return typeof actual === 'string' && new RegExp(o.$regex as string).test(actual);
    if ('$approx' in o) {
      const tol = (o.$tol as number) ?? 1e-6;
      return typeof actual === 'number' && Math.abs(actual - (o.$approx as number)) <= tol;
    }
    if ('$anyOf' in o) return (o.$anyOf as Matcher[]).some((x) => matchValue(x, actual));
    if ('$exists' in o) return (actual !== undefined && actual !== null) === o.$exists;
    if ('$subset' in o) return matchSubset(o.$subset as Record<string, Matcher>, actual);
    return deepEqual(m, actual);
  }
  return deepEqual(m, actual);
}
export function matchSubset(expected: Record<string, Matcher>, actual: unknown): boolean {
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([k, m]) => matchValue(m, (actual as Record<string, unknown>)[k]));
}
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
export function getPath(v: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v);
}
