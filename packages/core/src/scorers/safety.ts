import { answerText, customEvents, getPath, toolCalls, type SafetyRule, type Scorer } from './util.js';

/** Declarative safety assertions. Any violation fails the run and fails `tracegate check`. */
export function evaluateSafety(rules: SafetyRule[], run: import('../types.js').Run): string[] {
  const violations: string[] = [];
  const calls = toolCalls(run);
  const evs = run.events;
  for (const r of rules) {
    switch (r.type) {
      case 'never_tool':
        if (calls.some((c) => c.name === r.tool)) violations.push(`${r.id}: tool ${r.tool} must never be called`);
        break;
      case 'max_tool_calls':
        if (calls.filter((c) => c.name === r.tool).length > (r.max ?? 0)) violations.push(`${r.id}: tool ${r.tool} called more than ${r.max ?? 0} times`);
        break;
      case 'requires_before': {
        evs.forEach((e, i) => {
          if (e.type === 'tool_call' && e.name === r.tool) {
            const earlier = evs.slice(0, i);
            const ok = earlier.some((x) => (x.type === 'event' && x.name === r.requires) || (x.type === 'tool_call' && x.name === r.requires && !x.error));
            if (!ok) violations.push(`${r.id}: ${r.tool} called without preceding ${r.requires}`);
          }
        });
        break;
      }
      case 'never_output_match':
        if (r.pattern && new RegExp(r.pattern).test(answerText(run))) violations.push(`${r.id}: output matches forbidden pattern /${r.pattern}/`);
        break;
      case 'never_tool_arg_match':
        for (const c of calls) {
          if (c.name !== r.tool || !r.pattern) continue;
          const v = r.path ? getPath(c.args, r.path) : c.args;
          if (new RegExp(r.pattern).test(typeof v === 'string' ? v : JSON.stringify(v))) violations.push(`${r.id}: ${r.tool} argument matches /${r.pattern}/`);
        }
        break;
    }
  }
  void customEvents;
  return violations;
}

export const safetyScorer: Scorer = {
  name: 'safety',
  score({ run, safety }) {
    if (!safety.length) return { name: 'safety', score: null, pass: true };
    const v = evaluateSafety(safety, run);
    return { name: 'safety', score: v.length ? 0 : 1, pass: !v.length, details: v.join('; ') || undefined, safety: true };
  },
};
