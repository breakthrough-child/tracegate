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
- Packages are publish-ready (`files`, `exports`, `publishConfig`) but not published; steps in README. Repository URLs point at github.com/breakthrough-child/tracegate.
- No outside users, stars or testimonials are claimed anywhere; `docs/FEEDBACK_LOG.md` is an empty template.
- Release prep: `Tracegate_prompt_v2.md` (the build prompt) is not part of the repo; untracked and git-ignored. Git author email rewritten to the GitHub noreply address so no personal email is in public history.
- Quick start writes its HTML report under `.tracegate/` so a clean checkout stays lint-clean after following the README.
- Real-model experiment (e7): `claude-haiku-5-5` at the list price you gave ($0.10/$0.50 per Mtok), a hard cap of $0.35 enforced by a ledger-backed guard (`experiments/budget.ts`: reserves a worst case before each call, refuses a call that could pass the cap, charges failed calls at their worst case, so the reported cost is an upper bound). Order: smoke (3 cases) -> run -> judge, always last. Never run by `pnpm experiments`.
- Sample fixed before any real call: every second case of the 40 (20 cases), 3 trials, 2 variants. The task text said 5 trials, the cost rule said 3; the cost rule won.
- The API call is a plain `fetch` (no SDK, so the lockfile and CI are unchanged; `pnpm add` also hung on a flaky network). At most one retry per failed call; 4xx client errors are not retried. Errored runs are dropped from scoring and counted.
- Request settings for the real model: `output_config.effort = low`, no temperature (current Claude models reject a custom one), model-default thinking; the key is read from the git-ignored `.env.local`, never from shell env, and the base URL is fixed to api.anthropic.com.
- Judge: 10 items, alternating baseline/worse answers; its agreement is with Tracegate's rule-based scorers, NOT with humans. Human agreement stays "not yet measured" until the CSV is filled in; the labelling sheet is blind (random order, opaque ids, key in a separate file).
- Labelling sheet = 40 real answers (20 cases x baseline/worse, trial 0) from the real run.
- `examples/opsdesk` has no package.json (a new workspace member would change `pnpm-lock.yaml`); its import script loads the built core by path. Traces come from OpsDesk's saved eval outputs (outcomes, not raw requests), so they cannot be strictly replayed. The "regression" is mock-v3 -> mock-v1 (a revert scenario), labelled as such.
- GitHub Actions bumped to the latest majors (checkout v7, setup-node v7, pnpm/action-setup v6, upload-artifact v7, github-script v9); the Node 20 annotations are gone in the run after the bump.
- PR check: `.github/workflows/tracegate-pr.yml` runs `./action` on the example (mock model, live mode). PR #1 (worse prompt) got the bot comment (`docs/samples/pr-comment-github-action.md`) and was closed without merging; the branch was deleted. Its `test` job also failed, correctly, because the e2e tests assume the good prompt.
