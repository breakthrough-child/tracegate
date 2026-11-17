# CI

## What runs on every pull request
1. **Replay-mode check** (free, deterministic): the agent's own code (tools, orchestration, parsing) is run against recorded model responses. If a prompt or tool schema changed so that a request no longer matches the recording, the run fails with a diff (see `tracegate replay`).
2. **Scoring and gate:** `tracegate check --baseline <name> --candidate candidate` exits non-zero on any safety violation, absolute threshold breach, budget breach, or statistically supported regression.
3. **Report:** a Markdown PR comment and a self-contained HTML report.

Live checks (real model, costs money) are opt-in: call the action without `cassette`, on a schedule or a label.

## Replay catches different things from a live run
Replay proves that code around the model still works and that prompts/tool schemas did not drift unnoticed. It cannot tell you whether a *changed* prompt makes the model behave worse: the recorded answers are the old model's answers to the old prompt. For that, re-run live on a schedule or with a label and compare with `tracegate check`.

## GitHub Action (`action/action.yml`)
```yaml
- uses: OWNER/tracegate/action@v0
  with:
    agent: dist/agent.js
    dataset: tracegate/dataset.yaml
    baseline: main            # tracegate/baselines/main/results.json
    cassette: main-recording  # run set committed in .tracegate/runs/
    trials: "3"
```
Needs `permissions: pull-requests: write` for the comment. The comment is updated in place on each push. A full workflow is in `.github/workflows/tracegate-pr.example.yml`. This repository's own `ci.yml` runs the support-agent example in CI with no API key and **asserts that the broken variant fails the gate**.

## Baselines
`tracegate baseline update <run-set> [--name main]` copies the scored `results.json` into `tracegate/baselines/<name>/` (or `baselines` from the config). Commit it. The file is small, diff-able JSON, so a baseline change is reviewable in a pull request like any snapshot. Update baselines deliberately: accepting a lower baseline is how regressions get laundered.

## Config (`tracegate.config.mjs|js|yaml|json`)
```yaml
dataset: tracegate/dataset.yaml
thresholds: { task_success: 0.85 }          # absolute floors on the candidate
gate_metrics: [task_success]               # tested against the baseline
tolerance: 0.02                            # smallest worthwhile drop
budgets:
  max_mean_cost_usd: 0.02
  max_p95_latency_ms: 8000
  max_mean_tokens: 4000
  max_relative_increase: 0.15              # cost/latency/tokens rise, only when statistically supported
safety: [ ... ]                            # see docs/SCORERS.md
prices: { my-model: { input: 3, output: 15 } }   # USD per million tokens (defaults are illustrative and stale)
```
`.ts` configs need a TypeScript loader (for example run the CLI through `tsx`); `.mjs`, `.yaml` and `.json` need nothing.

## Dashboard artifact
`tracegate ui --export tracegate-dashboard.html` writes a single static file; `ci.yml` uploads it as an artifact.

## Exit codes
`0` pass; `1` gate failed (or replay mismatch, validation problems); `2` usage or configuration error.
