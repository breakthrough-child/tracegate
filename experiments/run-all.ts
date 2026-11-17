// Runs all six experiments in sequence. Raw outputs land in experiments/results/.
import { spawnSync } from 'node:child_process';
const only = process.argv[2];
for (const f of ['e1-noise', 'e2-false-regressions', 'e3-sensitivity', 'e4-judge', 'e5-cost-of-rigor', 'e6-budgets']) {
  if (only && !f.startsWith(only)) continue;
  console.log(`\n=== ${f} ===`);
  const r = spawnSync('pnpm', ['exec', 'tsx', `experiments/${f}.ts`], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
