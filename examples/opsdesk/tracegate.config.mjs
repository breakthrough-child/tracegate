const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export default {
  dir: 'examples/opsdesk/.tracegate',
  baselines: 'examples/opsdesk/baselines',
  dataset: 'examples/opsdesk/dataset.yaml',
  gate_metrics: ['task_success'],
  tolerance: 0.03,
  outcomes: {
    // OpsDesk's own policy checks that only need the recorded end state: intent, approval gates, escalation, citation.
    opsdesk_policy: (state, _run, c) => {
      const e = c.context;
      return (
        state.intent === e.intent &&
        sameSet(state.gated, e.gated) &&
        (e.escalate === null || state.escalated === e.escalate) &&
        (!e.cite_any.length || state.citations.some((id) => e.cite_any.includes(id.split(':')[0])))
      );
    },
  },
};
