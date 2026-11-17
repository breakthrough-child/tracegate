# Decisions made on the maintainer's behalf

One line each: decision, why.

- pnpm workspace with `tsc -b` project references (no bundler): zero build-tool surface, plain ESM output that `node` runs directly.
- Dependencies kept to `ajv` (JSON Schema validation; writing a validator by hand would be worse), `yaml` (YAML datasets/configs) and `commander` (CLI parsing, `--help`). Dev: typescript, vitest, tsx, eslint, prettier.
- **No statistics dependency**: bootstrap, paired bootstrap, exact binomial/McNemar, kappa, pass@k, Wilson are ~200 lines and tested against hand-computed values; a library would add weight and hide the assumptions.
- The unit of analysis is the **case** (cluster bootstrap over cases, trials averaged within a case) because trials of one case are correlated.
- Gate = paired-bootstrap CI entirely below zero AND point drop >= tolerance (default 0.02); default gated metric is `task_success` only, to avoid multiple-comparison inflation. McNemar is reported but not the gate.
- McNemar's "case passes" = more than half of its trials pass.
- Optional SQLite store uses built-in `node:sqlite` (Node >= 22.5, experimental) instead of `better-sqlite3`: no native build step. It is loaded lazily, so Node 20 works for everything else.
- JSONL files are the source of truth; SQLite is an index built with `tracegate index`.
- Strict replay serves model responses only; tools are executed for real so the tool code is tested. Replay requires the agent to consume exactly the recorded number of model calls.
- Trace `run_id` uses random UUIDs; case ids are file names, so run sets are diff-friendly.
- Baselines store scored `results.json` (small, reviewable) rather than full traces.
- Streaming model calls are not supported yet (clear error); recorded as a limitation.
- The Anthropic/OpenAI wrappers wrap the `messages.create` / `chat.completions.create` surface only, via duck typing, so no SDK is a dependency.
- Judges are plain `fetch` clients (Anthropic, OpenAI-compatible), also to avoid SDK dependencies. Not exercised against real APIs here (no key available).
- The example runs on a **rule-based mock LLM** (`examples/support-agent/src/mock-llm.ts`) with configurable noise/degradation, so it works with no key. All figures from it are labelled simulated. Latency of mock calls is simulated and reported as such (recorded via a non-enumerable `__latency_ms`).
- Experiments 1-3, 5, 6 use the simulated agent; experiment 4 uses a simulated judge with injected error rates (it validates the calibration machinery, not any real judge). Real-model experiments are marked "not yet measured" because no API key was available.
- Experiment-4 labels are "ground truth by construction" (a correct vs a deliberately wrong answer), not human annotations; the README says so.
- `opsdesk`/customer-ops dogfood: `../OpsDesk` contains only `OpsDesk_prompt_v2.md` (a prompt, no project), so the optional adapter example was skipped.
- OTLP export maps GenAI semantic-convention attributes where they apply and puts the rest under `tracegate.*`; the conventions are still evolving. Import supports GenAI-style and OpenInference-style attributes. Tested with file fixtures only, not a live backend.
- Python package is laid out for pip (`pyproject.toml`) but not published; it has no dependencies and duck-types the Anthropic/OpenAI clients.
- Config `.ts` files need a TS loader; the docs say so and recommend `.mjs`/`.yaml`.
- Prices in `DEFAULT_PRICES` are illustrative and stale on purpose; users override them.
- Dashboard is one static HTML file with inline JS/SVG (no framework, no build step, no external requests); comparisons are precomputed for the latest 8 run sets; traces embedded for the first 200 runs only to keep the file small.
- Packages are publish-ready (`files`, `exports`, `publishConfig`) but not published; steps in README. Repository URL placeholders (`OWNER`) need replacing.
- No outside users, stars or testimonials are claimed anywhere; `docs/FEEDBACK_LOG.md` is an empty template.
