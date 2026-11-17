import type { ExpectedTool, ToolCallEvent } from '../types.js';
import { matchSubset, na, toolCalls, type Scorer } from './util.js';

const callMatches = (exp: ExpectedTool, c: ToolCallEvent): boolean => exp.name === c.name && (!exp.args || matchSubset(exp.args, c.args));

/** Tool-call correctness: expected present, forbidden absent, argument matchers, ordering, extra-call penalty. */
export const toolScorer: Scorer = {
  name: 'tool_accuracy',
  score({ case: c, run }) {
    const e = c.expected;
    if (!e || (!e.tools && !e.forbidden_tools)) return na('tool_accuracy');
    const calls = toolCalls(run);
    const expected = e.tools ?? [];
    const problems: string[] = [];
    const used = new Set<number>();
    let matched = 0;
    let cursor = 0;
    for (const exp of expected) {
      let idx = -1;
      if (e.order === 'strict') {
        for (let i = cursor; i < calls.length; i++)
          if (callMatches(exp, calls[i]) && !used.has(i)) {
            idx = i;
            break;
          }
      } else {
        for (let i = 0; i < calls.length; i++)
          if (callMatches(exp, calls[i]) && !used.has(i)) {
            idx = i;
            break;
          }
      }
      if (idx >= 0) {
        used.add(idx);
        matched++;
        if (e.order === 'strict') cursor = idx + 1;
      } else if (!exp.optional) {
        const sameName = calls.some((x) => x.name === exp.name);
        problems.push(
          sameName
            ? `tool ${exp.name} called but arguments did not match ${JSON.stringify(exp.args)}${e.order === 'strict' ? ' (or out of order)' : ''}`
            : `expected tool ${exp.name} was not called`,
        );
      }
    }
    const required = expected.filter((x) => !x.optional).length;
    const forbidden = (e.forbidden_tools ?? []).filter((n) => calls.some((x) => x.name === n));
    for (const f of forbidden) problems.push(`forbidden tool ${f} was called`);
    const extras = calls.filter((_, i) => !used.has(i) && !forbidden.includes(calls[i].name)).length;
    if (e.max_extra_calls !== undefined && extras > e.max_extra_calls) {
      problems.push(`${extras} unnecessary tool calls (max ${e.max_extra_calls})`);
    }
    const recall = required ? Math.min(1, matched / required) : 1;
    const precision = matched + extras ? matched / (matched + extras) : 1;
    const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
    const score = forbidden.length ? 0 : required === 0 && expected.length === 0 ? (extras ? precision : 1) : f1;
    return { name: 'tool_accuracy', score, pass: problems.length === 0, details: problems.join('; ') || undefined };
  },
};
