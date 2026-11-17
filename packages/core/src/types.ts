/** Trace event types. See docs/TRACE_SPEC.md for the language-agnostic spec. */
export const TRACE_VERSION = 1;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
}

interface BaseEvent {
  v: number;
  run_id: string;
  id: string;
  parent_id?: string;
  /** ISO-8601 timestamp */
  ts: string;
  /** 0-based agent step this event belongs to */
  step?: number;
}

export interface RunStartEvent extends BaseEvent {
  type: 'run_start';
  case_id?: string;
  trial?: number;
  input: unknown;
  meta?: RunMeta;
}
export interface RunMeta {
  agent?: string;
  model?: string;
  prompt_version?: string;
  git_sha?: string;
  tags?: string[];
  simulated?: boolean;
  [k: string]: unknown;
}
export interface ModelCallEvent extends BaseEvent {
  type: 'model_call';
  provider: string;
  model: string;
  params?: Record<string, unknown>;
  request: unknown;
  response?: unknown;
  usage?: Usage;
  cost_usd?: number;
  latency_ms: number;
  retries?: number;
  error?: string;
}
export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration_ms: number;
}
export interface RetrievedItem {
  id: string;
  score?: number;
  text_hash?: string;
  text?: string;
}
export interface RetrievalEvent extends BaseEvent {
  type: 'retrieval';
  query: string;
  k?: number;
  results: RetrievedItem[];
  latency_ms?: number;
}
export interface CustomEvent extends BaseEvent {
  type: 'event';
  name: string;
  data?: unknown;
}
export interface RunEndEvent extends BaseEvent {
  type: 'run_end';
  status: 'ok' | 'error' | 'replay_mismatch';
  output?: unknown;
  state?: unknown;
  error?: string;
  duration_ms: number;
}
export type TraceEvent =
  | RunStartEvent
  | ModelCallEvent
  | ToolCallEvent
  | RetrievalEvent
  | CustomEvent
  | RunEndEvent;

export interface Run {
  run_id: string;
  case_id: string;
  trial: number;
  input: unknown;
  output: unknown;
  state?: unknown;
  status: RunEndEvent['status'];
  error?: string;
  meta: RunMeta;
  duration_ms: number;
  events: TraceEvent[];
}

/* ---------- datasets ---------- */

export type Matcher =
  | string
  | number
  | boolean
  | null
  | { $regex: string }
  | { $approx: number; $tol?: number }
  | { $anyOf: unknown[] }
  | { $subset: Record<string, unknown> }
  | { $exists: boolean }
  | Record<string, unknown>
  | unknown[];

export interface ExpectedTool {
  name: string;
  /** Argument matchers: exact value, {$regex}, {$approx,$tol}, {$anyOf}, {$subset}. Keys not listed are ignored. */
  args?: Record<string, Matcher>;
  optional?: boolean;
}
export interface AnswerChecks {
  exact?: string;
  contains?: string[];
  not_contains?: string[];
  regex?: string;
  json_schema?: Record<string, unknown>;
  /** Rubric text for the LLM judge. */
  judge?: string;
}
export interface RetrievalExpect {
  gold: string[];
  k?: number;
  /** Optional graded relevance for nDCG: id -> gain */
  gains?: Record<string, number>;
}
export interface Expected {
  tools?: ExpectedTool[];
  forbidden_tools?: string[];
  order?: 'strict' | 'any';
  max_extra_calls?: number;
  answer?: AnswerChecks;
  retrieval?: RetrievalExpect;
  /** Require every [id] citation to exist in retrieved set and quotes to appear in the cited chunk. */
  citations?: boolean;
  /** Name of an outcome check registered in config. */
  outcome?: string;
  behavior?: 'answer' | 'refuse' | 'escalate';
}
export interface Case {
  id: string;
  input: string | Record<string, unknown>;
  context?: unknown;
  tags?: string[];
  category?: string;
  expected?: Expected;
  labels?: { human?: 'pass' | 'fail'; note?: string };
}

/* ---------- scoring results ---------- */

export interface ScorerResult {
  name: string;
  /** 0..1, or null when the scorer does not apply to this run. */
  score: number | null;
  /** Whether a failure should fail the run. Defaults to true. */
  required?: boolean;
  pass: boolean;
  details?: string;
  /** True for safety violations, which fail `check` unconditionally. */
  safety?: boolean;
}
export interface TrialResult {
  trial: number;
  run_id: string;
  pass: boolean;
  status: Run['status'];
  scores: Record<string, number | null>;
  failures: string[];
  safety_violations: string[];
  steps: number;
  tokens: number;
  cost_usd: number;
  latency_ms: number;
  simulated_latency?: boolean;
}
export interface CaseResult {
  case_id: string;
  category?: string;
  tags: string[];
  trials: TrialResult[];
}
export interface RunsetResults {
  name: string;
  created: string;
  dataset?: string;
  meta: Record<string, unknown>;
  judge?: { model: string; temperature: number; rubric_hash?: string };
  cases: CaseResult[];
}
