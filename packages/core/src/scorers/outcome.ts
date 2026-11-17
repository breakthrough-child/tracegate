import { customEvents, na, toolCalls, type Scorer } from './util.js';

/** End-state check through a user-supplied function registered under `outcomes` in the config. */
export const outcomeScorer: Scorer = {
  name: 'outcome',
  async score({ case: c, run, outcomes }) {
    const name = c.expected?.outcome;
    if (!name) return na('outcome');
    const fn = outcomes[name];
    if (!fn) return { name: 'outcome', score: 0, pass: false, details: `outcome check "${name}" is not registered in config.outcomes` };
    let ok: boolean;
    try {
      ok = await fn(run.state, run, c);
    } catch (e) {
      return { name: 'outcome', score: 0, pass: false, details: `outcome check threw: ${(e as Error).message}` };
    }
    return { name: 'outcome', score: ok ? 1 : 0, pass: ok, details: ok ? undefined : `outcome "${name}" not satisfied by final state` };
  },
};

export const didEscalate = (run: import('../types.js').Run): boolean =>
  customEvents(run, 'escalation').length > 0 || toolCalls(run).some((t) => /escalat/i.test(t.name));
export const didRefuse = (run: import('../types.js').Run): boolean => customEvents(run, 'refusal').length > 0;

/**
 * Escalation / refusal correctness. `behavior_correct` fails the run when the behaviour is wrong.
 * `*_recall` applies only to cases that should escalate/refuse; `*_precision` only to runs that did.
 * Aggregated over cases they give precision and recall.
 */
export const behaviorScorer: Scorer = {
  name: 'behavior',
  score({ case: c, run }) {
    const want = c.expected?.behavior;
    const esc = didEscalate(run);
    const ref = didRefuse(run);
    const out = [
      { name: 'escalation_recall', score: want === 'escalate' ? (esc ? 1 : 0) : null, pass: true, required: false },
      { name: 'escalation_precision', score: esc ? (want === 'escalate' ? 1 : 0) : null, pass: true, required: false },
      { name: 'refusal_recall', score: want === 'refuse' ? (ref ? 1 : 0) : null, pass: true, required: false },
      { name: 'refusal_precision', score: ref ? (want === 'refuse' ? 1 : 0) : null, pass: true, required: false },
    ];
    if (!want) return [...out, na('behavior_correct')];
    const ok = want === 'escalate' ? esc : want === 'refuse' ? ref : !esc && !ref;
    return [
      ...out,
      {
        name: 'behavior_correct',
        score: ok ? 1 : 0,
        pass: ok,
        details: ok ? undefined : `expected behaviour "${want}" (escalated=${esc}, refused=${ref})`,
      },
    ];
  },
};
