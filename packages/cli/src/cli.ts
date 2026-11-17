import { Command } from 'commander';
import { spawnSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { judgeFromEnv } from '@tracegate/adapters';
import {
  Store, loadConfig, loadDataset, validateDataset, validateTrace, runDataset, scoreRunset, compare, check, calibrateJudge,
  promoteRun, sampleRuns, runToOtlp, otlpToRuns, indexToSqlite, readRunFile, parseJsonl, postOtlp, DEFAULT_CONFIG,
  type Agent, type RunsetResults, type Case, type TracegateConfig, type Run,
} from '@tracegate/core';
import { renderMarkdown, renderCompareHtml, viewText, viewHtml, buildDashboardData, renderDashboard } from '@tracegate/report';

type Cfg = TracegateConfig & typeof DEFAULT_CONFIG;

const gitSha = (): string | undefined => {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const write = (file: string, text: string) => {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, text);
  console.error(`wrote ${file}`);
};

async function loadAgent(file: string): Promise<{ agent: Agent; meta: Record<string, unknown> }> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`Agent module not found: ${file}`);
  const mod = await import(pathToFileURL(abs).href);
  const agent = mod.default ?? mod.agent;
  if (typeof agent !== 'function') throw new Error(`${file} must default-export an agent function (input, tg) => answer`);
  const meta = typeof mod.meta === 'function' ? await mod.meta() : (mod.meta ?? {});
  return { agent, meta };
}

/** Resolve a run set to scored results: store name, results.json path, directory, or committed baseline name. */
function resolveResults(store: Store, cfg: Cfg, ref: string): RunsetResults {
  const tries = [store.runsetDir(ref) + '/results.json', ref, join(ref, 'results.json'), join(cfg.baselines, ref, 'results.json'), join(cfg.baselines, ref + '.json')];
  for (const t of tries) if (existsSync(t) && t.endsWith('.json')) return JSON.parse(readFileSync(t, 'utf8')) as RunsetResults;
  throw new Error(`No scored results for "${ref}". Looked in: ${tries.join(', ')}. Did you run \`tracegate score\`?`);
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command('tracegate')
    .description('Record, replay, score and gate AI agent runs')
    .version('0.1.0')
    .option('-c, --config <file>', 'config file')
    .option('--dir <dir>', 'trace store directory');
  const ctx = async () => {
    const o = program.opts();
    const cfg = (await loadConfig(o.config)) as Cfg;
    return { cfg, store: new Store(o.dir ?? cfg.dir) };
  };
  const datasetOf = (cfg: Cfg, o: { dataset?: string }) => {
    const d = o.dataset ?? cfg.dataset;
    if (!d) throw new Error('No dataset: pass --dataset or set `dataset` in the config');
    return d;
  };

  program.command('init').description('scaffold a config, dataset and agent stub').action(() => {
    const files: Record<string, string> = {
      'tracegate.config.yaml': YAML.stringify({ dataset: 'tracegate/dataset.yaml', thresholds: { task_success: 0.8 }, tolerance: 0.03, gate_metrics: ['task_success'], safety: [], budgets: { max_mean_cost_usd: 0.05 } }),
      'tracegate/dataset.yaml': YAML.stringify([{ id: 'hello-1', input: 'Say hello', category: 'smoke', expected: { answer: { contains: ['hello'] } } }]),
      'tracegate/agent.mjs': `// Minimal agent. Replace with your own: use tg.model / wrapAnthropic / tg.tool so calls are recorded.\nexport default async function agent(input, tg) {\n  const res = await tg.model({ provider: 'demo', model: 'demo', request: { input } }, async () => ({ text: 'hello' }));\n  return res.text;\n}\n`,
    };
    for (const [f, t] of Object.entries(files)) {
      if (existsSync(f)) { console.error(`skip ${f} (exists)`); continue; }
      write(f, t);
    }
    console.log('Next: tracegate run --agent tracegate/agent.mjs --name first --trials 3');
  });

  program.command('validate <file>').description('validate a dataset (yaml/json) or a trace (.jsonl) against the schemas').action(async (file: string) => {
    let problems: string[];
    if (file.endsWith('.jsonl')) problems = validateTrace(parseJsonl(readFileSync(file, 'utf8')));
    else problems = validateDataset(loadDataset(file)).map((p) => `${p.case}: ${p.message}`);
    if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} problem(s)`); process.exit(1); }
    console.log(`${file}: valid`);
  });

  const runOpts = (c: Command) => c
    .requiredOption('--agent <module>', 'JS module default-exporting (input, tg) => answer')
    .option('--dataset <file>').option('--name <name>', 'run set name', 'run').option('--trials <n>', 'trials per case', '1')
    .option('--concurrency <n>', '', '4').option('--no-score', 'skip scoring').option('--judge <spec>', 'judge, e.g. anthropic:claude-sonnet-4-5')
    .option('--limit <n>', 'only the first n cases').option('--tag <tag>', 'only cases with this tag');

  async function doRun(o: Record<string, string | boolean | undefined>, mode: 'live' | 'replay') {
    const { cfg, store } = await ctx();
    const ds = datasetOf(cfg, { dataset: o.dataset as string | undefined });
    let cases = loadDataset(ds);
    if (o.tag) cases = cases.filter((c) => c.tags?.includes(o.tag as string));
    if (o.limit) cases = cases.slice(0, Number(o.limit));
    const { agent, meta } = await loadAgent(o.agent as string);
    const t0 = Date.now();
    const res = await runDataset({
      cases, agent, store, name: o.name as string, trials: Number(o.trials), mode, cassette: o.cassette as string | undefined, match: cfg.match,
      meta: { ...meta, git_sha: gitSha() }, prices: cfg.prices, redaction: cfg.redaction, concurrency: Number(o.concurrency), dataset: ds,
      onProgress: process.stderr.isTTY ? (d, t) => process.stderr.write(`\r${d}/${t} runs`) : undefined,
    });
    if (process.stderr.isTTY) process.stderr.write('\n');
    console.log(`${mode} run "${o.name}": ${res.runs} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${res.errors} errors${mode === 'replay' ? `, ${res.mismatches} replay mismatches` : ''}`);
    if (o.score !== false) {
      const judge = judgeFromEnv(o.judge as string | undefined);
      const r = await scoreRunset(store, cases, store.loadRuns(o.name as string), { config: cfg, judge, name: o.name as string, dataset: ds });
      printSummary(r);
    }
    if (mode === 'replay' && res.mismatches) {
      for (const r of store.loadRuns(o.name as string).filter((x) => x.status === 'replay_mismatch').slice(0, 5)) console.error(`\n[${r.case_id}] ${r.error}`);
      process.exitCode = 1;
    }
  }
  runOpts(program.command('run').description('run a dataset against an agent (live), record traces and score')).action((o) => doRun(o, 'live'));
  runOpts(program.command('replay').description('strict replay from a recorded run set: no network, fails on request drift').requiredOption('--cassette <runset>', 'recorded run set to replay')).action((o) => doRun(o, 'replay'));

  program.command('record <command...>').description('run any command with TRACEGATE_DIR / TRACEGATE_RUN_NAME set (for adapters in other languages)')
    .option('--name <name>', 'run set name', 'recorded').allowUnknownOption()
    .action(async (cmd: string[], o: { name: string }) => {
      const { store } = await ctx();
      store.writeManifest(o.name, { name: o.name, created: new Date().toISOString(), mode: 'record', git_sha: gitSha() });
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, TRACEGATE_DIR: store.dir, TRACEGATE_RUN_NAME: o.name, TRACEGATE_RUNSET_DIR: store.runsetDir(o.name) } });
      let n = 0;
      try { n = store.loadRuns(o.name).length; } catch { /* none */ }
      console.log(`recorded ${n} run(s) into ${store.runsetDir(o.name)}`);
      process.exitCode = r.status ?? 1;
    });

  program.command('score <runset>').description('score a run set against a dataset').option('--dataset <file>').option('--judge <spec>')
    .action(async (name: string, o: { dataset?: string; judge?: string }) => {
      const { cfg, store } = await ctx();
      const ds = datasetOf(cfg, o);
      const r = await scoreRunset(store, loadDataset(ds), store.loadRuns(name), { config: cfg, judge: judgeFromEnv(o.judge), name, dataset: ds });
      printSummary(r);
    });

  program.command('compare <a> <b>').description('compare baseline A with candidate B').option('--html <file>').option('--md <file>').option('--json <file>')
    .action(async (a: string, b: string, o: { html?: string; md?: string; json?: string }) => {
      const { cfg, store } = await ctx();
      const c = compare(resolveResults(store, cfg, a), resolveResults(store, cfg, b), { tolerance: cfg.tolerance, alpha: cfg.alpha, min_cases: cfg.min_cases });
      const res = check(resolveResults(store, cfg, b), resolveResults(store, cfg, a), cfg);
      printComparison(c);
      if (o.html) write(o.html, renderCompareHtml(c, { check: res, ...runsFor(store, a, b) }));
      if (o.md) write(o.md, renderMarkdown(res));
      if (o.json) write(o.json, JSON.stringify(c, null, 2));
    });

  program.command('check').description('CI gate: exits 1 on safety failures, threshold/budget breaches or significant regressions')
    .option('--baseline <ref>').requiredOption('--candidate <ref>').option('--format <f>', 'text|markdown', 'text').option('--out <file>', 'write the report here').option('--html <file>')
    .action(async (o: { baseline?: string; candidate: string; format: string; out?: string; html?: string }) => {
      const { cfg, store } = await ctx();
      const cand = resolveResults(store, cfg, o.candidate);
      const base = o.baseline ? resolveResults(store, cfg, o.baseline) : undefined;
      const res = check(cand, base, cfg);
      const md = renderMarkdown(res, `Tracegate: ${o.candidate}${o.baseline ? ' vs ' + o.baseline : ''}`);
      if (o.out) write(o.out, md);
      if (o.html && res.comparison) write(o.html, renderCompareHtml(res.comparison, { check: res, ...runsFor(store, o.baseline!, o.candidate) }));
      if (o.format === 'markdown') console.log(md);
      else {
        console.log(res.ok ? 'PASS' : 'FAIL');
        for (const f of res.findings) console.log(`  [${f.level}] ${f.kind}: ${f.message}`);
      }
      process.exit(res.ok ? 0 : 1);
    });

  const bl = program.command('baseline').description('manage committed baselines');
  bl.command('update <runset>').option('--name <name>', 'baseline name (default: the run set name)').description('copy scored results into the committed baselines directory')
    .action(async (runset: string, o: { name?: string }) => {
      const { cfg, store } = await ctx();
      const src = join(store.runsetDir(runset), 'results.json');
      if (!existsSync(src)) throw new Error(`${src} not found: run \`tracegate score ${runset}\` first`);
      const dest = join(cfg.baselines, o.name ?? runset, 'results.json');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      console.log(`baseline updated: ${dest}  (review the diff and commit it)`);
    });

  const jc = program.command('judge').description('judge tools');
  jc.command('calibrate').description('compare judge verdicts with human labels (percent agreement, Cohen\'s kappa)')
    .option('--dataset <file>').requiredOption('--runset <name>').option('--judge <spec>').option('--json <file>')
    .action(async (o: { dataset?: string; runset: string; judge?: string; json?: string }) => {
      const { cfg, store } = await ctx();
      const judge = judgeFromEnv(o.judge);
      if (!judge) throw new Error('No judge available: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --judge provider:model');
      const cases = loadDataset(datasetOf(cfg, o));
      const runs = new Map(store.loadRuns(o.runset).filter((r) => r.trial === 0).map((r) => [r.case_id, r]));
      const items = cases.filter((c) => c.labels?.human && c.expected?.answer?.judge && runs.has(c.id)).map((c) => ({
        id: c.id, rubric: c.expected!.answer!.judge!, question: String(c.input), answer: typeof runs.get(c.id)!.output === 'string' ? (runs.get(c.id)!.output as string) : JSON.stringify(runs.get(c.id)!.output), human: c.labels!.human!,
      }));
      const rep = await calibrateJudge(judge, items);
      console.log(`judge ${rep.judge.model} (temperature ${rep.judge.temperature}) on ${rep.n} human-labelled items\nagreement ${(rep.agreement * 100).toFixed(1)}%  kappa ${rep.kappa.toFixed(3)}\nconfusion ${JSON.stringify(rep.confusion)}`);
      rep.warnings.forEach((w) => console.log('warning: ' + w));
      if (o.json) write(o.json, JSON.stringify(rep, null, 2));
    });

  program.command('view <trace>').description('render one trace (file path, or run-set/case) as a timeline').option('--html <file>').option('--trial <n>', '', '0')
    .action(async (t: string, o: { html?: string; trial: string }) => {
      const { store } = await ctx();
      let run: Run;
      if (existsSync(t) && t.endsWith('.jsonl')) run = readRunFile(t);
      else {
        const [set, cid] = t.split('/');
        const found = store.loadRuns(set).find((r) => r.case_id === cid && r.trial === Number(o.trial));
        if (!found) throw new Error(`No run ${t} (trial ${o.trial})`);
        run = found;
      }
      console.log(viewText(run));
      if (o.html) write(o.html, viewHtml(run));
    });

  program.command('ui').description('local dashboard').option('--port <n>', '', '4173').option('--export [file]', 'write a static HTML bundle instead of serving')
    .action(async (o: { port: string; export?: string | boolean }) => {
      const { cfg, store } = await ctx();
      const build = () => renderDashboard(buildDashboardData(store, { tolerance: cfg.tolerance }));
      if (o.export) { write(typeof o.export === 'string' ? o.export : 'tracegate-dashboard.html', build()); return; }
      createServer((req, res) => {
        if (req.url?.startsWith('/')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(build()); }
      }).listen(Number(o.port), '127.0.0.1', () => console.log(`Tracegate dashboard: http://127.0.0.1:${o.port}  (Ctrl+C to stop)`));
    });

  program.command('promote <runId>').description('turn a recorded run into a dataset case (redacted)')
    .option('--runset <name>', 'run set to search (default: all)').option('--dataset <file>').option('--id <id>').option('--tag <t...>')
    .option('--expect-same', 'treat the observed tool calls as the expected behaviour').option('--answer-contains <s...>').option('--forbid-tool <t...>').option('--behavior <b>')
    .action(async (runId: string, o: Record<string, string | string[] | boolean | undefined>) => {
      const { cfg, store } = await ctx();
      const sets = o.runset ? [o.runset as string] : store.listRunsets();
      let run: Run | undefined;
      for (const s of sets) { try { run = store.loadRuns(s).find((r) => r.run_id.startsWith(runId)); } catch { /* skip */ } if (run) break; }
      if (!run) throw new Error(`Run ${runId} not found`);
      const c = promoteRun(run, { id: o.id as string, tags: o.tag as string[], expectSame: !!o.expectSame, answerContains: o.answerContains as string[], forbidTools: o.forbidTool as string[], behavior: o.behavior as 'answer' | 'refuse' | 'escalate' | undefined, redaction: cfg.redaction });
      const ds = datasetOf(cfg, { dataset: o.dataset as string | undefined });
      const existing = existsSync(ds) ? loadDataset(ds) : [];
      if (existing.some((x) => x.id === c.id)) throw new Error(`Case id ${c.id} already exists in ${ds}`);
      write(ds, YAML.stringify([...existing, c]));
      console.log(`promoted ${run.run_id} -> case "${c.id}" in ${ds}`);
    });

  program.command('sample').description('random sample of recorded runs for human review').requiredOption('--runset <name>').option('-n <n>', '', '10').option('--seed <n>', '', '1').option('--failed-only')
    .action(async (o: { runset: string; n: string; seed: string; failedOnly?: boolean }) => {
      const { store } = await ctx();
      const res = store.readResults(o.runset);
      let runs = store.loadRuns(o.runset);
      if (o.failedOnly && res) { const bad = new Set(res.cases.flatMap((c) => c.trials.filter((t) => !t.pass).map((t) => t.run_id))); runs = runs.filter((r) => bad.has(r.run_id)); }
      for (const r of sampleRuns(runs, Number(o.n), Number(o.seed))) console.log(`${r.run_id.slice(0, 8)}  ${r.case_id} t${r.trial} [${r.status}]  ${String(typeof r.input === 'string' ? r.input : JSON.stringify(r.input)).slice(0, 80)}`);
    });

  const ot = program.command('otel').description('OpenTelemetry interoperability');
  ot.command('export <runset>').option('--out <file>', 'OTLP/JSON file', 'otlp-traces.json').option('--endpoint <url>', 'also POST to an OTLP/HTTP collector')
    .action(async (runset: string, o: { out: string; endpoint?: string }) => {
      const { store } = await ctx();
      const docs = store.loadRuns(runset).map((r) => runToOtlp(r));
      const merged = { resourceSpans: docs.flatMap((d) => d.resourceSpans) };
      write(o.out, JSON.stringify(merged));
      if (o.endpoint) { await postOtlp(o.endpoint, merged); console.log(`posted to ${o.endpoint}`); }
    });
  ot.command('import <file>').requiredOption('--name <runset>').description('import OTLP/JSON (GenAI or OpenInference attributes) as a run set')
    .action(async (file: string, o: { name: string }) => {
      const { store } = await ctx();
      const runs = otlpToRuns(JSON.parse(readFileSync(file, 'utf8')));
      store.writeManifest(o.name, { name: o.name, created: new Date().toISOString(), mode: 'record', imported_from: file });
      for (const r of runs) { const f = store.runFile(o.name, r.case_id, r.trial); writeFileSync(f, r.events.map((e) => JSON.stringify(e)).join('\n') + '\n'); }
      console.log(`imported ${runs.length} run(s) as "${o.name}". Score with: tracegate score ${o.name} --dataset <file>`);
    });

  program.command('index').description('build a SQLite index of all traces (queryable)').option('--out <file>', '', '.tracegate/index.db')
    .action(async (o: { out: string }) => { const { store } = await ctx(); console.log(await indexToSqlite(store, o.out)); });

  void spawn; void appendFileSync;
  await program.parseAsync(argv);
}

function printSummary(r: RunsetResults): void {
  const pass = r.cases.flatMap((c) => c.trials).filter((t) => t.pass).length;
  const total = r.cases.flatMap((c) => c.trials).length;
  console.log(`scored "${r.name}": ${pass}/${total} trial-runs passed across ${r.cases.length} cases`);
  const failing = r.cases.filter((c) => c.trials.some((t) => !t.pass)).slice(0, 8);
  for (const c of failing) console.log(`  ✗ ${c.case_id}: ${c.trials.find((t) => !t.pass)!.failures[0]?.slice(0, 120)}`);
}

function printComparison(c: ReturnType<typeof compare>): void {
  console.log(`${c.baseline.name} vs ${c.candidate.name}: ${c.n_paired} paired cases`);
  for (const m of c.metrics.filter((x) => ['task_success', 'tool_accuracy', 'cost_usd', 'latency_ms', 'tokens', 'retrieval_recall', 'citation_accuracy'].includes(x.name))) {
    console.log(`  ${m.name.padEnd(18)} ${m.baseline.toFixed(4)} -> ${m.candidate.toFixed(4)}  diff ${m.diff.diff.toFixed(4)} [${m.diff.lo.toFixed(4)}, ${m.diff.hi.toFixed(4)}] p=${m.diff.p.toFixed(3)}  ${m.verdict}`);
  }
  console.log(`  McNemar exact: ${c.pass_test.regressed} regressed / ${c.pass_test.improved} improved, p=${c.pass_test.p.toFixed(4)}`);
  c.notes.forEach((n) => console.log('  note: ' + n));
}

function runsFor(store: Store, a: string, b: string): { baselineRuns?: Run[]; candidateRuns?: Run[] } {
  const load = (n: string) => { try { return store.loadRuns(n); } catch { return undefined; } };
  return { baselineRuns: load(a), candidateRuns: load(b) };
}
