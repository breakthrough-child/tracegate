# Plan (working notes)

1. Scaffold monorepo: core, adapters, report, cli; example agent with mock LLM.
2. Core: trace types and schema, recorder, replay (cassette), scorers, statistics, compare, gate.
3. Reports: HTML compare, Markdown PR comment, trace view, dashboard.
4. CLI commands: init, record, run, replay, score, compare, check, baseline update, judge calibrate, validate, view, ui, promote, sample, otel, index.
5. Python recorder + OpenTelemetry import/export; GitHub Action and CI.
6. Six experiments (simulated unless stated), saved under `experiments/results/`.
7. Docs, write-up, final test/lint/type-check pass.
