import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, runDataset, diffJson, normalizeRequest, type Agent, type Case } from '../src/index.js';

const cases: Case[] = [{ id: 'a', input: 'hi' }, { id: 'b', input: 'yo' }];
const mkAgent = (system: string): Agent => async (input, tg) => {
  const res = await tg.model({ provider: 'p', model: 'm', request: { system, q: input }, usage: () => ({ input_tokens: 3, output_tokens: 2 }) }, async () => ({ text: `echo ${input}` }));
  return (res as { text: string }).text;
};

describe('replay engine', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'tg-')));
  it('records, then replays with no live call', async () => {
    await runDataset({ cases, agent: mkAgent('s1'), store, name: 'rec' });
    let live = 0;
    const agent: Agent = async (input, tg) => {
      const r = await tg.model({ provider: 'p', model: 'm', request: { system: 's1', q: input } }, async () => { live++; return { text: 'LIVE' }; });
      return (r as { text: string }).text;
    };
    const res = await runDataset({ cases, agent, store, name: 'rep', mode: 'replay', cassette: 'rec' });
    expect(res.mismatches).toBe(0);
    expect(live).toBe(0);
    expect(store.loadRuns('rep').map((r) => r.output)).toEqual(['echo hi', 'echo yo']);
  });
  it('fails with a diff when the request drifted', async () => {
    const res = await runDataset({ cases, agent: mkAgent('s2 changed'), store, name: 'drift', mode: 'replay', cassette: 'rec' });
    expect(res.mismatches).toBe(2);
    const r = store.loadRuns('drift')[0];
    expect(r.status).toBe('replay_mismatch');
    expect(r.error).toContain('request.system: recorded "s1" -> now "s2 changed"');
  });
  it('can ignore chosen fields, or normalize whitespace', async () => {
    const ok = await runDataset({ cases, agent: mkAgent('s2 changed'), store, name: 'ign', mode: 'replay', cassette: 'rec', match: { ignore: ['request.system'] } });
    // ignore paths are relative to the request itself
    expect(ok.mismatches).toBe(2);
    const ok2 = await runDataset({ cases, agent: mkAgent('s2 changed'), store, name: 'ign2', mode: 'replay', cassette: 'rec', match: { ignore: ['system'] } });
    expect(ok2.mismatches).toBe(0);
    const ws = await runDataset({ cases, agent: mkAgent('s1  '), store, name: 'ws', mode: 'replay', cassette: 'rec', match: { mode: 'normalized' } });
    expect(ws.mismatches).toBe(0);
  });
  it('fails when the agent makes extra or fewer calls', async () => {
    const more: Agent = async (input, tg) => {
      await mkAgent('s1')(input, tg);
      await tg.model({ provider: 'p', model: 'm', request: { extra: true } }, async () => ({}));
      return 'x';
    };
    expect((await runDataset({ cases, agent: more, store, name: 'more', mode: 'replay', cassette: 'rec' })).mismatches).toBe(2);
    const fewer: Agent = async () => 'no model call';
    expect((await runDataset({ cases, agent: fewer, store, name: 'fewer', mode: 'replay', cassette: 'rec' })).mismatches).toBe(2);
  });
  it('redacts secrets before they reach disk', async () => {
    const a: Agent = async (input, tg) => {
      await tg.model({ provider: 'p', model: 'm', request: { q: input, api_key: 'sk-ant-SECRETSECRET123456' } }, async () => ({ text: 'mail me at bob@example.com' }));
      return 'ok';
    };
    await runDataset({ cases: [cases[0]], agent: a, store, name: 'red' });
    const text = JSON.stringify(store.loadRuns('red'));
    expect(text).not.toContain('SECRETSECRET');
    expect(text).not.toContain('bob@example.com');
  });
  it('diff and normalize helpers', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] })).toEqual(['b.1: recorded 2 -> now 3']);
    expect(normalizeRequest({ b: ' x  y ', a: 1 }, { mode: 'normalized' })).toEqual({ a: 1, b: 'x y' });
  });
});
