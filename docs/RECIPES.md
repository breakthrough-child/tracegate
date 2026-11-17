# Recipes

## Compare two models
```bash
# same dataset, 5 trials each, different model chosen by env var in your agent module
MODEL=model-a tracegate run --agent dist/agent.js --name model-a --trials 5
MODEL=model-b tracegate run --agent dist/agent.js --name model-b --trials 5
tracegate compare model-a model-b --html compare.html
```
Read the cost-versus-quality section: a model that is 2 points worse and 5x cheaper may be the right choice. Interpret `insufficient data` literally.

## Compare two prompts
Keep the prompt in a file selected by an env var (`PROMPT_FILE`), record a run set per prompt, `compare`. Put `prompt_version` in the agent module's exported `meta` so each run records it. Replay will (correctly) refuse to replay a changed prompt; use live runs for prompt comparisons.

## Gate a monorepo
One config and dataset per agent directory; run the action per directory with `working-directory`, and path-filter the workflow:
```yaml
on:
  pull_request:
    paths: ['agents/support/**', 'packages/shared/**']
```
Use a matrix over agent directories when several agents share code. Baselines live next to each agent.

## The production-to-test loop (flywheel)
1. **Record** production or staging runs with the recorder (redaction on; keep `storeChunkText` off unless you must).
2. **Sample:** `tracegate sample --runset prod-week-12 -n 20 --seed 1` (add `--failed-only` to focus on runs your scorers flagged).
3. **Review** each sampled trace with `tracegate view prod-week-12/<case>` and decide what the right behaviour was.
4. **Promote:** `tracegate promote <run-id> --dataset tracegate/dataset.yaml --expect-same` when the observed behaviour was correct, or state the correct behaviour explicitly with `--answer-contains`, `--forbid-tool`, `--behavior escalate`. Promotion refuses to run with no stated expectation, and applies redaction to everything it copies.
5. **Re-run** the suite and commit the dataset change (and a new baseline if you meant to change behaviour).

## Score traces from another language or tool
- Python: `pip install -e python/tracegate-py`, record with `Recorder`, run through `tracegate record --name py -- python3 agent.py`, then `tracegate score py --dataset d.yaml`.
- OpenTelemetry / OpenInference: `tracegate otel import traces.json --name imported`, then `tracegate score`. Map your span ids to dataset case ids with the `tracegate.case_id` attribute.

## Send traces to Langfuse, Phoenix or any OTLP backend
`tracegate otel export <run-set> --out traces.json --endpoint http://localhost:4318` (the OTLP/HTTP JSON path `/v1/traces` is appended). Not tested against a live backend in CI (CI uses file fixtures only); treat backend rendering as unverified.

## Calibrate a judge
Add `labels: { human: pass|fail }` to at least 40 cases that have `expected.answer.judge`, record answers, then `tracegate judge calibrate --runset base --judge anthropic:<model>`.
