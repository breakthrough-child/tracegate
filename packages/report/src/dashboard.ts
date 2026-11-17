import { compare, summarize, type Comparison, type RunsetResults, type Store, type Summary, type Run } from '@tracegate/core';
import { CSS } from './util.js';

export interface DashboardRun {
  runset: string;
  run_id: string;
  case_id: string;
  trial: number;
  pass: boolean;
  status: string;
  cost_usd: number;
  latency_ms: number;
  failures: string[];
  events?: unknown[];
}
export interface DashboardData {
  generated: string;
  runsets: { name: string; created: string; git_sha?: string; simulated?: boolean; mode?: string; summary: Summary; cases: RunsetResults['cases'] }[];
  comparisons: Record<string, Comparison>;
  runs: DashboardRun[];
}

/** Collect everything the dashboard needs from a store. Comparisons are precomputed for the latest runsets. */
export function buildDashboardData(store: Store, opts: { tolerance?: number; maxCompared?: number; maxRunsWithEvents?: number } = {}): DashboardData {
  const names = store.listRunsets().filter((n) => store.readResults(n));
  const sets = names.map((n) => ({ n, r: store.readResults(n)!, m: store.readManifest(n) })).sort((a, b) => a.r.created.localeCompare(b.r.created));
  const runsets = sets.map(({ n, r, m }) => ({ name: n, created: r.created, git_sha: m?.git_sha, simulated: m?.simulated, mode: m?.mode, summary: summarize(r), cases: r.cases }));
  const comparisons: Record<string, Comparison> = {};
  const recent = sets.slice(-(opts.maxCompared ?? 8));
  for (const a of recent) for (const b of recent) if (a !== b) comparisons[`${a.n}|${b.n}`] = compare(a.r, b.r, { tolerance: opts.tolerance });
  const runs: DashboardRun[] = [];
  let withEvents = 0;
  const cap = opts.maxRunsWithEvents ?? 200;
  for (const { n, r } of sets) {
    let loaded: Run[] | undefined;
    for (const c of r.cases) for (const t of c.trials) {
      const row: DashboardRun = { runset: n, run_id: t.run_id, case_id: c.case_id, trial: t.trial, pass: t.pass, status: t.status, cost_usd: t.cost_usd, latency_ms: t.latency_ms, failures: t.failures };
      if (withEvents < cap) {
        try {
          loaded ??= store.loadRuns(n);
          row.events = loaded.find((x) => x.run_id === t.run_id)?.events;
          withEvents++;
        } catch { /* traces may be absent for baseline-only result files */ }
      }
      runs.push(row);
    }
  }
  return { generated: new Date().toISOString(), runsets, comparisons, runs };
}

/** Static single-file dashboard. The same HTML is used by `tracegate ui` (served) and `--export`. */
export function renderDashboard(data: DashboardData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tracegate dashboard</title><style>${CSS}
nav{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}nav button,select,input{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 10px}nav button.on{border-color:var(--acc);color:var(--acc)}
.tick{font-size:10px;fill:var(--mut)}svg text{font-family:system-ui,sans-serif}</style></head><body><main>
<h1>Tracegate dashboard</h1><p class="mut" id="gen"></p><nav id="nav"></nav><div id="view"></div></main>
<script id="data" type="application/json">${json}</script><script>${CLIENT}</script></body></html>`;
}

const CLIENT = String.raw`
const D = JSON.parse(document.getElementById('data').textContent);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fx = (x, d = 3) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d)) : 'n/a');
const pc = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a');
const money = (x) => '$' + (x < 0.01 ? x.toFixed(5) : x.toFixed(3));
const state = { tab: 'overview', a: null, b: null, run: null, set: null, filter: {} };
const sets = D.runsets;
$('#gen').textContent = 'Generated ' + D.generated + ' · ' + sets.length + ' run set(s)' + (sets.some((s) => s.simulated) ? ' · includes SIMULATED (mock model) runs' : '');
if (sets.length) { state.set = sets[sets.length - 1].name; state.b = state.set; state.a = (sets[sets.length - 2] || sets[sets.length - 1]).name; }
const tabs = [['overview','Overview'],['runs','Runs'],['compare','Compare'],['trends','Trends'],['failures','Failure explorer'],['cost','Cost vs quality']];
const metric = (s, n) => s.summary.metrics.find((m) => m.name === n);
function nav() { $('#nav').innerHTML = tabs.map(([k, l]) => '<button class="' + (state.tab === k ? 'on' : '') + '" data-k="' + k + '">' + l + '</button>').join(''); document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.k; state.run = null; render(); })); }
function setSel(id, cur) { return '<select id="' + id + '">' + sets.map((s) => '<option ' + (s.name === cur ? 'selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>'; }
function line(points, w, h, color, fmt) {
  if (!points.length) return '';
  const xs = points.map((_, i) => i), ys = points.map((p) => p.y);
  const lo = Math.min(...points.map((p) => p.lo ?? p.y)), hi = Math.max(...points.map((p) => p.hi ?? p.y));
  const span = hi - lo || 1, X = (i) => 40 + (points.length < 2 ? 0.5 : i / (points.length - 1)) * (w - 60), Y = (v) => h - 24 - ((v - lo) / span) * (h - 44);
  let s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="max-width:' + w + 'px">';
  s += '<text class="tick" x="2" y="' + Y(hi) + '">' + fmt(hi) + '</text><text class="tick" x="2" y="' + Y(lo) + '">' + fmt(lo) + '</text>';
  s += '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + points.map((p, i) => X(i) + ',' + Y(p.y)).join(' ') + '"/>';
  points.forEach((p, i) => {
    if (p.lo !== undefined) s += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + Y(p.lo) + '" y2="' + Y(p.hi) + '" stroke="' + color + '" opacity=".4"/>';
    s += '<circle cx="' + X(i) + '" cy="' + Y(p.y) + '" r="4" fill="' + (p.bad ? 'var(--bad)' : color) + '"><title>' + esc(p.label) + ': ' + fmt(p.y) + (p.bad ? ' (significant regression vs previous)' : '') + '</title></circle>';
    if (p.bad) s += '<text x="' + X(i) + '" y="' + (Y(p.y) - 8) + '" text-anchor="middle" fill="var(--bad)" font-size="12">▼</text>';
    s += '<text class="tick" x="' + X(i) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(p.label.slice(0, 10)) + '</text>';
  });
  return s + '</svg>';
}
function overview() {
  const s = sets.find((x) => x.name === state.set); if (!s) return '<p class="mut">No scored run sets yet. Run <code>tracegate score</code> first.</p>';
  const cards = [['task_success','Task success',pc],['citation_accuracy','Groundedness (citations)',pc],['retrieval_recall','Retrieval recall',pc],['tool_accuracy','Tool accuracy',pc],['latency_ms','Mean latency',(x) => Math.round(x) + ' ms'],['cost_usd','Mean cost / request',money],['failure_rate','Failure rate',pc]];
  return '<p>Run set: ' + setSel('sel-set', state.set) + (s.simulated ? ' <span class="pill warn">simulated</span>' : '') + '</p><div class="grid">' + cards.map(([k, l, f]) => { const m = metric(s, k); return '<div class="card"><div class="mut">' + l + '</div><div class="big">' + (m ? f(m.ci.estimate) : 'n/a') + '</div><div class="mut">' + (m ? '95% CI ' + f(m.ci.lo) + ' to ' + f(m.ci.hi) : 'not measured') + '</div></div>'; }).join('') + '</div><p class="mut">' + s.summary.n_cases + ' cases × ' + s.summary.trials_per_case + ' trial(s); flaky cases: ' + s.summary.flaky_cases.length + (s.summary.pass_at_k ? '; pass@' + s.summary.pass_at_k.k + ' = ' + fx(s.summary.pass_at_k.value) : '') + '; safety violations: ' + s.summary.safety_violations + '</p>';
}
function runsView() {
  if (state.run) { const r = D.runs.find((x) => x.run_id === state.run); const t0 = r.events && r.events.length ? Date.parse(r.events[0].ts) : 0;
    return '<p><button id="back">← back</button></p><h2>' + esc(r.case_id) + ' · trial ' + r.trial + ' <span class="pill ' + (r.pass ? 'good' : 'bad') + '">' + (r.pass ? 'pass' : 'fail') + '</span></h2>' + (r.failures.length ? '<p class="bad">' + r.failures.map(esc).join('<br>') + '</p>' : '') + '<table>' + (r.events || []).map((e) => '<tr><td class="mut">+' + (Date.parse(e.ts) - t0) + 'ms</td><td><span class="pill">' + e.type + '</span></td><td>' + esc(e.type === 'model_call' ? e.model + ' · ' + (e.usage ? e.usage.input_tokens + '→' + e.usage.output_tokens + ' tok · ' : '') + (e.cost_usd !== undefined ? money(e.cost_usd) + ' · ' : '') + Math.round(e.latency_ms) + 'ms' : e.type === 'tool_call' ? e.name + '(' + JSON.stringify(e.args) + ') ' + (e.error ? 'ERROR ' + e.error : '→ ' + JSON.stringify(e.result)) + ' · ' + Math.round(e.duration_ms) + 'ms' : e.type === 'retrieval' ? '"' + e.query + '" → ' + e.results.map((x) => x.id).join(', ') : e.type === 'event' ? e.name + ' ' + JSON.stringify(e.data || '') : JSON.stringify(e.output || e.input || e.error || '')).slice(0, 300) + '</td></tr>').join('') + '</table>' + (r.events ? '' : '<p class="mut">No trace stored for this run.</p>'); }
  const f = state.filter; const rows = D.runs.filter((r) => (!f.set || r.runset === f.set) && (!f.q || r.case_id.includes(f.q)) && (!f.st || (f.st === 'fail' ? !r.pass : r.pass)));
  return '<p>' + '<select id="f-set"><option value="">all run sets</option>' + sets.map((s) => '<option ' + (f.set === s.name ? 'selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select> <select id="f-st"><option value="">pass+fail</option><option ' + (f.st === 'fail' ? 'selected' : '') + '>fail</option><option ' + (f.st === 'pass' ? 'selected' : '') + '>pass</option></select> <input id="f-q" placeholder="case id contains" value="' + esc(f.q || '') + '"></p><table><tr><th>run set</th><th>case</th><th>trial</th><th>result</th><th>cost</th><th>latency</th><th></th></tr>' + rows.slice(0, 300).map((r) => '<tr><td>' + esc(r.runset) + '</td><td>' + esc(r.case_id) + '</td><td>' + r.trial + '</td><td class="' + (r.pass ? 'good' : 'bad') + '">' + (r.pass ? 'pass' : 'fail') + '</td><td>' + money(r.cost_usd) + '</td><td>' + Math.round(r.latency_ms) + ' ms</td><td>' + (r.events ? '<a href="#" data-run="' + r.run_id + '">view</a>' : '') + '</td></tr>').join('') + '</table><p class="mut">' + rows.length + ' runs' + (rows.length > 300 ? ' (first 300 shown)' : '') + '</p>';
}
function compareView() {
  const c = D.comparisons[state.a + '|' + state.b];
  const head = '<p>Baseline ' + setSel('sel-a', state.a) + ' Candidate ' + setSel('sel-b', state.b) + '</p>';
  if (!c) return head + '<p class="mut">Choose two different run sets (comparisons are precomputed for the latest ' + Math.min(8, sets.length) + ').</p>';
  return head + (c.notes.map((n) => '<p class="warn">' + esc(n) + '</p>').join('')) + '<table><tr><th>metric</th><th>baseline</th><th>candidate</th><th>diff [95% CI]</th><th>p</th><th>verdict</th></tr>' + c.metrics.map((m) => '<tr><td>' + esc(m.name) + '</td><td>' + fx(m.baseline) + '</td><td>' + fx(m.candidate) + '</td><td>' + fx(m.diff.diff) + ' [' + fx(m.diff.lo) + ', ' + fx(m.diff.hi) + ']</td><td>' + fx(m.diff.p) + '</td><td class="' + (m.verdict === 'regression' ? 'bad' : m.verdict === 'improvement' ? 'good' : 'mut') + '">' + m.verdict.replace(/_/g, ' ') + '</td></tr>').join('') + '</table><p class="mut">Exact McNemar: ' + c.pass_test.regressed + ' regressed, ' + c.pass_test.improved + ' improved, p = ' + fx(c.pass_test.p) + '</p><h2>Changed cases</h2><table>' + c.changes.filter((x) => x.kind !== 'unchanged').map((x) => '<tr><td class="' + (x.kind === 'regressed' ? 'bad' : x.kind === 'improved' ? 'good' : 'warn') + '">' + x.kind + '</td><td>' + esc(x.case_id) + '</td><td>' + pc(x.baseline_pass_rate) + ' → ' + pc(x.candidate_pass_rate) + '</td><td class="mut">' + esc(x.failures[0] || '') + '</td></tr>').join('') + '</table>';
}
function trends() {
  const mk = (name, fmt, col) => line(sets.map((s, i) => { const m = metric(s, name); if (!m) return null; const prev = sets[i - 1]; const c = prev && D.comparisons[prev.name + '|' + s.name]; const bad = name === 'task_success' && c && c.metrics.find((x) => x.name === 'task_success' && x.verdict === 'regression'); return { y: m.ci.estimate, lo: m.ci.lo, hi: m.ci.hi, label: s.name, bad: !!bad }; }).filter(Boolean), 640, 170, col, fmt);
  const p95 = line(sets.map((s) => ({ y: s.summary.p95_latency_ms.estimate, lo: s.summary.p95_latency_ms.lo, hi: s.summary.p95_latency_ms.hi, label: s.name })), 640, 170, 'var(--warn)', (x) => Math.round(x) + 'ms');
  return '<p class="mut">Run sets in chronological order (commit: ' + sets.map((s) => esc((s.git_sha || '-').slice(0, 7))).join(', ') + '). ▼ marks a significant task-success regression versus the previous run set (precomputed for the latest 8 only).</p><h2>Pass rate</h2>' + mk('task_success', pc, 'var(--acc)') + '<h2>Mean cost per case</h2>' + mk('cost_usd', money, 'var(--good)') + '<h2>p95 latency</h2>' + p95;
}
function failures() {
  const s = sets.find((x) => x.name === state.set); if (!s) return '';
  const byTag = {}, byCat = {}, byScorer = {};
  for (const c of s.cases) { const fails = c.trials.filter((t) => !t.pass); if (!fails.length) continue; const n = fails.length / c.trials.length; for (const t of c.tags) byTag[t] = (byTag[t] || 0) + n; byCat[c.category || '(none)'] = (byCat[c.category || '(none)'] || 0) + n; for (const t of fails) for (const m of t.failures) { const k = m.split(':')[0]; byScorer[k] = (byScorer[k] || 0) + 1 / c.trials.length; } }
  const tbl = (o, h) => '<h2>' + h + '</h2><table>' + Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + fx(v, 1) + ' failing case-equivalents</td></tr>').join('') + '</table>';
  return '<p>Run set: ' + setSel('sel-set', state.set) + '</p>' + (Object.keys(byCat).length ? tbl(byCat, 'By category') + tbl(byTag, 'By tag') + tbl(byScorer, 'By failing check') : '<p class="good">No failures in this run set.</p>');
}
function cost() {
  const pts = sets.map((s) => ({ l: s.name, q: (metric(s, 'task_success') || { ci: { estimate: 0 } }).ci.estimate, c: (metric(s, 'cost_usd') || { ci: { estimate: 0 } }).ci.estimate }));
  const mc = Math.max(...pts.map((p) => p.c), 1e-9) * 1.2;
  return '<svg viewBox="0 0 640 300" width="100%" style="max-width:640px"><line x1="50" y1="260" x2="620" y2="260" stroke="var(--line)"/><line x1="50" y1="20" x2="50" y2="260" stroke="var(--line)"/><text class="tick" x="330" y="290" text-anchor="middle">mean cost per case (USD)</text><text class="tick" x="8" y="140" transform="rotate(-90 8 140)">pass rate</text>' + pts.map((p) => '<circle cx="' + (50 + p.c / mc * 560) + '" cy="' + (260 - p.q * 240) + '" r="6" fill="var(--acc)"><title>' + esc(p.l) + ': ' + pc(p.q) + ', ' + money(p.c) + '</title></circle><text class="tick" x="' + (58 + p.c / mc * 560) + '" y="' + (256 - p.q * 240) + '">' + esc(p.l.slice(0, 14)) + '</text>').join('') + '</svg>';
}
function render() {
  nav(); const v = { overview, runs: runsView, compare: compareView, trends, failures, cost }[state.tab](); $('#view').innerHTML = v;
  const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onchange = e.oninput = () => { fn(e.value); render(); }; };
  on('sel-set', (x) => (state.set = x)); on('sel-a', (x) => (state.a = x)); on('sel-b', (x) => (state.b = x));
  on('f-set', (x) => (state.filter.set = x)); on('f-st', (x) => (state.filter.st = x)); 
  const q = document.getElementById('f-q'); if (q) q.onchange = () => { state.filter.q = q.value; render(); };
  const bk = document.getElementById('back'); if (bk) bk.onclick = () => { state.run = null; render(); };
  document.querySelectorAll('[data-run]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); state.run = a.dataset.run; render(); }));
}
render();
`;
