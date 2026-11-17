import { makeRedactor, DEFAULT_REDACTION, type RedactionRules } from './redact.js';
import { rng } from './stats.js';
import type { Case, ExpectedTool, Run, ToolCallEvent } from './types.js';

export interface PromoteOptions {
  id?: string;
  tags?: string[];
  category?: string;
  /** Treat the observed behaviour as correct: expected tools = observed calls. */
  expectSame?: boolean;
  answerContains?: string[];
  forbidTools?: string[];
  behavior?: 'answer' | 'refuse' | 'escalate';
  redaction?: RedactionRules;
}

/** Turn a recorded run into a dataset case. Redaction is applied to everything copied from the trace. */
export function promoteRun(run: Run, o: PromoteOptions = {}): Case {
  const redact = makeRedactor(o.redaction ?? DEFAULT_REDACTION);
  const input = redact(run.input) as Case['input'];
  const c: Case = { id: o.id ?? `promoted-${run.run_id.slice(0, 8)}`, input, tags: ['promoted', ...(o.tags ?? [])], category: o.category };
  const expected: NonNullable<Case['expected']> = {};
  if (o.expectSame) {
    const calls = run.events.filter((e): e is ToolCallEvent => e.type === 'tool_call' && !e.error);
    expected.tools = calls.map<ExpectedTool>((t) => ({ name: t.name, args: redact(t.args) as ExpectedTool['args'] }));
    expected.order = 'strict';
  }
  if (o.answerContains?.length) expected.answer = { contains: o.answerContains };
  if (o.forbidTools?.length) expected.forbidden_tools = o.forbidTools;
  if (o.behavior) expected.behavior = o.behavior;
  if (!Object.keys(expected).length) {
    throw new Error('Refusing to promote a case with no expectations: pass --expect-same, --answer-contains, --forbid-tool or --behavior to state the expected behaviour.');
  }
  c.expected = expected;
  return c;
}

/** Seeded random sample (Fisher-Yates) of runs for human review. */
export function sampleRuns<T>(items: T[], n: number, seed = 1): T[] {
  const a = [...items];
  const r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
