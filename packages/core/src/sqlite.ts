import type { Store } from './store.js';

/** Optional SQLite index over a store (uses the built-in node:sqlite, Node >= 22.5). */
export async function indexToSqlite(store: Store, file: string): Promise<{ runs: number; events: number }> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS runs;
    CREATE TABLE runs(runset TEXT, run_id TEXT, case_id TEXT, trial INT, status TEXT, duration_ms REAL, cost_usd REAL, tokens INT, steps INT);
    CREATE TABLE events(runset TEXT, run_id TEXT, id TEXT, type TEXT, name TEXT, ts TEXT, latency_ms REAL, json TEXT);
    CREATE INDEX events_type ON events(type, name);`);
  const insRun = db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)');
  const insEv = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)');
  let runs = 0;
  let events = 0;
  for (const name of store.listRunsets()) {
    for (const r of store.loadRuns(name)) {
      let cost = 0;
      let tokens = 0;
      let steps = 0;
      for (const e of r.events) {
        if (e.type === 'model_call') {
          cost += e.cost_usd ?? 0;
          tokens += (e.usage?.input_tokens ?? 0) + (e.usage?.output_tokens ?? 0);
          steps++;
        }
        const en = e as unknown as Record<string, unknown>;
        insEv.run(
          name, r.run_id, e.id, e.type,
          (en.name as string) ?? (en.model as string) ?? null,
          e.ts, (en.latency_ms as number) ?? (en.duration_ms as number) ?? null,
          JSON.stringify(e),
        );
        events++;
      }
      insRun.run(name, r.run_id, r.case_id, r.trial, r.status, r.duration_ms, cost, tokens, steps);
      runs++;
    }
  }
  db.close();
  return { runs, events };
}

export async function querySqlite(file: string, sql: string): Promise<unknown[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
