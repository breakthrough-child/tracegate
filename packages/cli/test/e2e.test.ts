import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const bin = join(root, 'packages/cli/dist/bin.js');
const ex = join(root, 'examples/support-agent');
const dir = mkdtempSync(join(tmpdir(), 'tg-e2e-'));
const tg = (args: string[], env: Record<string, string> = {}, cwd = root) =>
  spawnSync('node', [bin, '-c', join(ex, 'tracegate.config.mjs'), '--dir', dir, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
const entry = join(ex, 'dist/entry.js');
const run = (name: string, env: Record<string, string>, trials = '3') =>
  tg(['run', '--agent', entry, '--name', name, '--trials', trials, '--dataset', join(ex, 'dataset.yaml')], env);

describe('CLI end to end (no API key, mock model)', () => {
  it('records and scores a baseline', () => {
    const r = run('base', { SUPPORT_VARIANT: 'good', SUPPORT_NOISE: '0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('120 runs');
    const res = JSON.parse(readFileSync(join(dir, 'runs/base/results.json'), 'utf8'));
    expect(res.cases).toHaveLength(40);
    expect(res.cases.flatMap((c: { trials: { pass: boolean }[] }) => c.trials).every((t: { pass: boolean }) => t.pass)).toBe(true);
  });
  it('gate passes for an identical agent and fails for the broken prompt', () => {
    run('same', { SUPPORT_VARIANT: 'good', SUPPORT_NOISE: '0' });
    expect(tg(['check', '--baseline', 'base', '--candidate', 'same']).status).toBe(0);
    run('bad', { SUPPORT_VARIANT: 'prompt', SUPPORT_NOISE: '0', SUPPORT_DEGRADE: '0.3' });
    const c = tg(['check', '--baseline', 'base', '--candidate', 'bad']);
    expect(c.status).toBe(1);
    expect(c.stdout).toContain('task_success regressed');
  });
  it('gate fails on a safety violation regardless of the baseline', () => {
    run('unsafe', { SUPPORT_VARIANT: 'approval', SUPPORT_NOISE: '0' });
    const c = tg(['check', '--candidate', 'unsafe']);
    expect(c.status).toBe(1);
    expect(c.stdout).toContain('safety');
  });
  it('strict replay passes unchanged and shows a diff when the tool schema drifts', () => {
    const ok = tg(
      ['replay', '--cassette', 'base', '--agent', entry, '--name', 'rp', '--trials', '3', '--dataset', join(ex, 'dataset.yaml')],
      { SUPPORT_VARIANT: 'good', SUPPORT_NOISE: '0' },
    );
    expect(ok.status).toBe(0);
    const drift = tg(
      [
        'replay',
        '--cassette',
        'base',
        '--agent',
        entry,
        '--name',
        'rp2',
        '--trials',
        '1',
        '--limit',
        '2',
        '--dataset',
        join(ex, 'dataset.yaml'),
      ],
      { SUPPORT_VARIANT: 'schema', SUPPORT_NOISE: '0' },
    );
    expect(drift.status).toBe(1);
    expect(drift.stderr + drift.stdout).toContain('input_schema.properties');
  });
  it('compare writes a self-contained HTML report, markdown and JSON', () => {
    const html = join(dir, 'c.html');
    const r = tg(['compare', 'base', 'bad', '--html', html, '--md', join(dir, 'c.md'), '--json', join(dir, 'c.json')]);
    expect(r.status).toBe(0);
    const h = readFileSync(html, 'utf8');
    expect(h).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(h).toContain('Headline metrics');
    expect(readFileSync(join(dir, 'c.md'), 'utf8')).toContain('Tracegate');
  });
  it('baseline update, promote, sample, view, validate, ui --export, otel, index', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tg-cwd-'));
    const t = (args: string[]) => tg(args, {}, cwd);
    expect(t(['baseline', 'update', 'base', '--name', 'main']).status).toBe(0);
    expect(existsSync(join(cwd, 'examples/support-agent/baselines/main/results.json'))).toBe(true);
    expect(t(['check', '--baseline', 'main', '--candidate', 'same']).status).toBe(0);
    const ds = join(cwd, 'ds.yaml');
    writeFileSync(ds, readFileSync(join(ex, 'dataset.yaml')));
    const first = readFileSync(join(dir, 'runs/base/status-1__t0.jsonl'), 'utf8').split('\n')[0];
    const runId = JSON.parse(first).run_id as string;
    expect(t(['promote', runId.slice(0, 8), '--dataset', ds, '--id', 'prod-1', '--expect-same']).status).toBe(0);
    expect(readFileSync(ds, 'utf8')).toContain('prod-1');
    expect(t(['promote', runId.slice(0, 8), '--dataset', ds, '--id', 'prod-2']).status).not.toBe(0);
    expect(t(['sample', '--runset', 'base', '-n', '3']).stdout.trim().split('\n')).toHaveLength(3);
    expect(t(['view', 'base/refund-1']).stdout).toContain('TOOL   issue_refund');
    expect(t(['validate', ds]).status).toBe(0);
    expect(t(['validate', join(dir, 'runs/base/status-1__t0.jsonl')]).status).toBe(0);
    const out = join(cwd, 'dash.html');
    expect(t(['ui', '--export', out]).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('Tracegate dashboard');
    const otel = join(cwd, 'o.json');
    expect(t(['otel', 'export', 'base', '--out', otel]).status).toBe(0);
    expect(t(['otel', 'import', otel, '--name', 'imported']).stdout).toContain('imported 120 run(s)');
    expect(t(['index', '--out', join(cwd, 'i.db')]).stdout).toContain('runs');
  });
  it('validate reports a bad dataset with a non-zero exit', () => {
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, '- id: x\n  input: hi\n  expected: { order: sideways }\n');
    const r = tg(['validate', bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('order');
  });
  it('python-recorded traces can be scored by the CLI', () => {
    const py = spawnSync('python3', ['--version']);
    if (py.status !== 0) return;
    const rec = tg(['record', '--name', 'py', '--', 'python3', join(root, 'python/examples/py_agent.py')]);
    expect(rec.status).toBe(0);
    const s = tg(['score', 'py', '--dataset', join(root, 'python/examples/dataset.yaml')]);
    expect(s.stdout).toContain('2/2 trial-runs passed');
    const trace = readFileSync(join(dir, 'runs/py/py-1__t0.jsonl'), 'utf8');
    expect(trace).not.toContain('help@example.com');
    expect(trace).not.toContain('sk-ant-abcdefghij');
  });
});
