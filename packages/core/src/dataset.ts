import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import YAML from 'yaml';
import { validateCase } from './schema.js';
import type { Case } from './types.js';

export function loadDataset(file: string): Case[] {
  const text = readFileSync(file, 'utf8');
  const ext = extname(file).toLowerCase();
  let data: unknown;
  if (ext === '.jsonl') data = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  else if (ext === '.json') data = JSON.parse(text);
  else data = YAML.parse(text);
  const cases = (Array.isArray(data) ? data : (data as { cases?: unknown })?.cases) as Case[] | undefined;
  if (!Array.isArray(cases)) throw new Error(`${file}: expected a list of cases or {cases: [...]}`);
  return cases;
}

export interface DatasetProblem {
  case: string;
  message: string;
}
export function validateDataset(cases: Case[]): DatasetProblem[] {
  const out: DatasetProblem[] = [];
  const seen = new Set<string>();
  cases.forEach((c, i) => {
    const id = (c as { id?: string })?.id ?? `#${i + 1}`;
    for (const m of validateCase(c)) out.push({ case: id, message: m });
    if (seen.has(id)) out.push({ case: id, message: 'duplicate case id' });
    seen.add(id);
    for (const t of c.expected?.tools ?? []) if (!t.name) out.push({ case: id, message: 'expected tool without name' });
    const rx = [c.expected?.answer?.regex].filter(Boolean) as string[];
    for (const r of rx) {
      try { new RegExp(r); } catch { out.push({ case: id, message: `invalid regex /${r}/` }); }
    }
  });
  return out;
}
