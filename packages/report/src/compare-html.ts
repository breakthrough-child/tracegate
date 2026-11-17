import type { CheckResult, Comparison, Run } from '@tracegate/core';
import { lowerIsBetter } from '@tracegate/core';
import { esc, f, money, page, pct } from './util.js';
import { viewText } from './view.js';

function tracePair(a?: Run, b?: Run): string {
  const col = (r?: Run, label = '') =>
    `<div><b>${label}</b>${r ? `<pre>${esc(viewText(r))}</pre>` : '<p class="mut">(no trace)</p>'}</div>`;
  return `<div class="cols">${col(a, 'baseline')}${col(b, 'candidate')}</div>`;
}

function scatter(c: Comparison): string {
  const pts = [
    { l: c.baseline.name, ...c.cost_quality.baseline, k: 'var(--mut)' },
    { l: c.candidate.name, ...c.cost_quality.candidate, k: 'var(--acc)' },
  ];
  const maxC = Math.max(...pts.map((p) => p.cost), 1e-9) * 1.3;
  const X = (v: number) => 50 + (v / maxC) * 380;
  const Y = (q: number) => 150 - q * 130;
  return `<svg viewBox="0 0 460 190" width="100%" style="max-width:520px" role="img" aria-label="cost versus quality"><line x1="50" y1="150" x2="440" y2="150" stroke="var(--line)"/><line x1="50" y1="20" x2="50" y2="150" stroke="var(--line)"/>
  <text x="240" y="178" text-anchor="middle" fill="var(--mut)" font-size="11">mean cost per case (USD) →</text><text x="10" y="90" fill="var(--mut)" font-size="11" transform="rotate(-90 10 90)">pass rate →</text>
  ${pts.map((p) => `<circle cx="${X(p.cost)}" cy="${Y(p.quality)}" r="6" fill="${p.k}"/><text x="${X(p.cost) + 9}" y="${Y(p.quality) + 4}" font-size="11" fill="var(--fg)">${esc(p.l)} (${pct(p.quality)}, ${money(p.cost)})</text>`).join('')}</svg>`;
}

/** Self-contained HTML compare report (no server, no external assets). */
export function renderCompareHtml(
  c: Comparison,
  opts: { check?: CheckResult; baselineRuns?: Run[]; candidateRuns?: Run[]; title?: string } = {},
): string {
  const fmtFor = (n: string) => (n === 'cost_usd' ? money : n === 'latency_ms' ? (x: number) => Math.round(x) + ' ms' : f);
  const verdictCls = (m: Comparison['metrics'][number]) =>
    m.verdict === 'regression' ? 'bad' : m.verdict === 'improvement' ? 'good' : m.verdict === 'insufficient_data' ? 'warn' : 'mut';
  const metricRows = c.metrics
    .map(
      (m) =>
        `<tr><td>${esc(m.name)}</td><td>${fmtFor(m.name)(m.baseline)}</td><td>${fmtFor(m.name)(m.candidate)}</td><td>${m.diff.diff >= 0 ? '+' : ''}${f(m.diff.diff)} <span class="mut">(${f(m.diff.lo)}, ${f(m.diff.hi)})</span></td><td>${f(m.diff.p)}</td><td>${f(m.diff.effect_size, 2)}</td><td class="${verdictCls(m)}">${esc(m.verdict.replace(/_/g, ' '))}${lowerIsBetter(m.name) ? ' <span class="mut">(lower is better)</span>' : ''}</td></tr>`,
    )
    .join('');
  const bRuns = new Map((opts.baselineRuns ?? []).filter((r) => r.trial === 0).map((r) => [r.case_id, r]));
  const cRuns = new Map((opts.candidateRuns ?? []).filter((r) => r.trial === 0).map((r) => [r.case_id, r]));
  const changed = c.changes.filter((x) => x.kind !== 'unchanged');
  const caseRows = changed
    .map(
      (x) =>
        `<details><summary><span class="pill ${x.kind === 'regressed' ? 'bad' : x.kind === 'improved' ? 'good' : 'warn'}">${x.kind}</span> <code>${esc(x.case_id)}</code> ${pct(x.baseline_pass_rate)} → ${pct(x.candidate_pass_rate)} <span class="mut">${esc(x.category ?? '')}</span></summary>${x.failures.length ? `<p class="bad">${x.failures.map(esc).join('<br>')}</p>` : ''}${tracePair(bRuns.get(x.case_id), cRuns.get(x.case_id))}</details>`,
    )
    .join('');
  const findings = opts.check
    ? `<h2>Gate: ${opts.check.ok ? '<span class="good">passed</span>' : '<span class="bad">failed</span>'}</h2><ul>${opts.check.findings.map((x) => `<li class="${x.level === 'fail' ? 'bad' : x.level === 'warn' ? 'warn' : 'mut'}">${esc(x.kind)}: ${esc(x.message)}</li>`).join('')}</ul>`
    : '';
  const body = `<h1>${esc(opts.title ?? 'Tracegate comparison')}</h1><p class="mut">${esc(c.baseline.name)} (baseline) vs ${esc(c.candidate.name)} (candidate) · ${c.n_paired} paired cases · ${c.baseline.trials_per_case} / ${c.candidate.trials_per_case} trials per case</p>
${findings}${c.notes.map((n) => `<p class="warn">${esc(n)}</p>`).join('')}
<h2>Headline metrics</h2><table><tr><th>metric</th><th>baseline</th><th>candidate</th><th>diff (95% paired-bootstrap CI)</th><th>p</th><th>effect size d<sub>z</sub></th><th>verdict</th></tr>${metricRows}</table>
<p class="mut">Pass/fail changes (exact McNemar on discordant cases): ${c.pass_test.regressed} regressed, ${c.pass_test.improved} improved, p = ${f(c.pass_test.p)}. pass@${c.candidate.pass_at_k?.k ?? '-'}: ${c.baseline.pass_at_k ? f(c.baseline.pass_at_k.value) : 'n/a'} → ${c.candidate.pass_at_k ? f(c.candidate.pass_at_k.value) : 'n/a'}. p95 latency: ${Math.round(c.baseline.p95_latency_ms.estimate)} → ${Math.round(c.candidate.p95_latency_ms.estimate)} ms.</p>
<h2>By category</h2><table><tr><th>category</th><th>cases</th><th>baseline</th><th>candidate</th><th>diff</th></tr>${c.by_category.map((x) => `<tr><td>${esc(x.category)}</td><td>${x.n}</td><td>${pct(x.baseline)}</td><td>${pct(x.candidate)}</td><td class="${x.diff < 0 ? 'bad' : x.diff > 0 ? 'good' : 'mut'}">${x.diff >= 0 ? '+' : ''}${(x.diff * 100).toFixed(1)} pts</td></tr>`).join('')}</table>
<h2>Cost versus quality</h2>${scatter(c)}
<h2>Changed cases (${changed.length})</h2>${caseRows || '<p class="mut">No case changed.</p>'}
<p class="mut">Flaky cases: baseline ${c.baseline.flaky_cases.length}, candidate ${c.candidate.flaky_cases.length}.</p>`;
  return page(opts.title ?? 'Tracegate comparison', body);
}
