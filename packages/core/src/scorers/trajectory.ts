import { modelCalls, toolCalls, type Scorer } from './util.js';

export interface Trajectory {
  steps: number;
  tokens: number;
  cost_usd: number;
  latency_ms: number;
  loops: string[];
  retries: number;
}

export function trajectoryOf(run: import('../types.js').Run): Trajectory {
  const m = modelCalls(run);
  const t = toolCalls(run);
  const counts = new Map<string, number>();
  for (const c of t) {
    const k = c.name + JSON.stringify(c.args);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const loops = [...counts.entries()].filter(([, n]) => n >= 3).map(([k, n]) => `${k.slice(0, 60)} x${n}`);
  return {
    steps: m.length,
    tokens: m.reduce((a, c) => a + (c.usage?.input_tokens ?? 0) + (c.usage?.output_tokens ?? 0), 0),
    cost_usd: m.reduce((a, c) => a + (c.cost_usd ?? 0), 0),
    latency_ms: m.reduce((a, c) => a + c.latency_ms, 0) + t.reduce((a, c) => a + c.duration_ms, 0),
    loops,
    retries: m.reduce((a, c) => a + (c.retries ?? 0), 0) + m.filter((c) => c.error).length,
  };
}

/** Loop detection: the same tool call with identical arguments three or more times. */
export const loopScorer: Scorer = {
  name: 'loop_free',
  score({ run }) {
    const t = trajectoryOf(run);
    return { name: 'loop_free', score: t.loops.length ? 0 : 1, pass: !t.loops.length, details: t.loops.join('; ') || undefined };
  },
};
