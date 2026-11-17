import type { Run, TraceEvent } from '@tracegate/core';
import { esc, page } from './util.js';

const short = (x: unknown, n = 140): string => {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s === undefined ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function line(e: TraceEvent, t0: number): string {
  const dt = `+${String(Date.parse(e.ts) - t0).padStart(5)}ms`;
  switch (e.type) {
    case 'run_start':
      return `${dt}  RUN    case=${e.case_id} trial=${e.trial} input=${short(e.input, 100)}`;
    case 'model_call': {
      const tok = e.usage ? ` ${e.usage.input_tokens}→${e.usage.output_tokens} tok` : '';
      const cost = e.cost_usd !== undefined ? ` $${e.cost_usd.toFixed(5)}` : '';
      return `${dt}  MODEL  ${e.provider}/${e.model}${tok}${cost} ${Math.round(e.latency_ms)}ms${e.error ? ' ERROR ' + e.error : ''}${e.retries ? ` retries=${e.retries}` : ''}\n                  ↳ ${short(responseText(e.response), 120)}`;
    }
    case 'tool_call':
      return `${dt}  TOOL   ${e.name}(${short(e.args, 80)}) ${e.error ? 'ERROR ' + e.error : '→ ' + short(e.result, 80)} ${Math.round(e.duration_ms)}ms`;
    case 'retrieval':
      return `${dt}  RETR   "${short(e.query, 60)}" → [${e.results.map((r) => r.id + (r.score !== undefined ? `:${r.score}` : '')).join(', ')}]`;
    case 'event':
      return `${dt}  EVENT  ${e.name} ${short(e.data, 80)}`;
    case 'run_end':
      return `${dt}  END    ${e.status}${e.error ? ' ' + short(e.error, 160) : ''} output=${short(e.output, 140)}`;
  }
}
export function responseText(r: unknown): string {
  const x = r as
    | { content?: { type: string; text?: string; name?: string; input?: unknown }[]; choices?: { message?: { content?: string } }[] }
    | undefined;
  if (x?.content) return x.content.map((b) => (b.type === 'text' ? b.text : `[tool_use ${b.name} ${JSON.stringify(b.input)}]`)).join(' ');
  if (x?.choices) return x.choices[0]?.message?.content ?? '';
  return short(r, 200);
}

export function viewText(run: Run): string {
  const t0 = Date.parse(run.events[0]?.ts ?? '') || 0;
  return [`Run ${run.run_id}  [${run.status}]  ${Math.round(run.duration_ms)}ms`, ...run.events.map((e) => line(e, t0))].join('\n');
}

export function viewHtml(run: Run): string {
  const t0 = Date.parse(run.events[0]?.ts ?? '') || 0;
  const rows = run.events.map(
    (e) =>
      `<tr><td class="mut">+${Date.parse(e.ts) - t0}ms</td><td><span class="pill">${e.type}</span></td><td><pre>${esc(line(e, t0).replace(/^\+\s*\d+ms\s+\w+\s+/, ''))}</pre><details><summary>raw</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details></td></tr>`,
  );
  return page(
    `Trace ${run.case_id}`,
    `<h1>Trace: ${esc(run.case_id)} <span class="pill">${esc(run.status)}</span></h1><p class="mut">run ${esc(run.run_id)} · trial ${run.trial} · ${Math.round(run.duration_ms)} ms</p><table>${rows.join('')}</table>`,
  );
}
