import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import type { PriceTable } from './pricing.js';
import type { RedactionRules } from './redact.js';
import type { MatchOptions } from './replay.js';
import type { Scorer, SafetyRule, ScoreContext } from './scorers/index.js';

export interface Budgets {
  /** max mean cost (USD) per case */
  max_mean_cost_usd?: number;
  /** max p95 latency (ms) per case */
  max_p95_latency_ms?: number;
  /** max mean tokens per case */
  max_mean_tokens?: number;
  /** fail when cost/latency/tokens rise by more than this fraction AND the rise is statistically supported */
  max_relative_increase?: number;
}

export interface TracegateConfig {
  dir?: string;
  dataset?: string;
  /** absolute floors for metrics, e.g. { task_success: 0.9 } (checked on the candidate's point estimate) */
  thresholds?: Record<string, number>;
  /** metrics the regression gate tests against the baseline (default: task_success) */
  gate_metrics?: string[];
  /** smallest drop worth failing on, in metric units (default 0.02) */
  tolerance?: number;
  alpha?: number;
  min_cases?: number;
  budgets?: Budgets;
  safety?: SafetyRule[];
  scorers?: Scorer[];
  required?: Record<string, boolean>;
  prices?: PriceTable;
  redaction?: RedactionRules;
  match?: MatchOptions;
  outcomes?: ScoreContext['outcomes'];
  /** id -> text, for citation quote checks and judge context */
  corpus?: Record<string, string>;
  baselines?: string;
}

export const DEFAULT_CONFIG: Required<Pick<TracegateConfig, 'dir' | 'tolerance' | 'alpha' | 'min_cases' | 'gate_metrics' | 'baselines'>> = {
  dir: '.tracegate',
  tolerance: 0.02,
  alpha: 0.05,
  min_cases: 10,
  gate_metrics: ['task_success'],
  baselines: 'tracegate/baselines',
};

export async function loadConfig(path?: string, cwd = process.cwd()): Promise<TracegateConfig & typeof DEFAULT_CONFIG> {
  const candidates = path
    ? [path]
    : [
        'tracegate.config.mjs',
        'tracegate.config.js',
        'tracegate.config.ts',
        'tracegate.config.yaml',
        'tracegate.config.yml',
        'tracegate.config.json',
      ];
  for (const c of candidates) {
    const f = resolve(cwd, c);
    if (!existsSync(f)) continue;
    let cfg: TracegateConfig;
    if (/\.ya?ml$/.test(f)) cfg = YAML.parse(readFileSync(f, 'utf8')) ?? {};
    else if (f.endsWith('.json')) cfg = JSON.parse(readFileSync(f, 'utf8'));
    else {
      try {
        const mod = await import(pathToFileURL(f).href);
        cfg = mod.default ?? mod.config ?? {};
      } catch (e) {
        throw new Error(
          `Could not load ${f}: ${(e as Error).message}${f.endsWith('.ts') ? ' (.ts configs need a TS loader such as tsx; use .mjs or .yaml otherwise)' : ''}`,
          { cause: e },
        );
      }
    }
    return { ...DEFAULT_CONFIG, ...cfg };
  }
  if (path) throw new Error(`Config file not found: ${path}`);
  return { ...DEFAULT_CONFIG };
}
export const defineConfig = (c: TracegateConfig): TracegateConfig => c;
