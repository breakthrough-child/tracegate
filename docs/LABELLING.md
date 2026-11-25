# Human labelling and judge calibration

**Status: real human-label agreement is _not yet measured_.** The sheet exists; nobody has filled it in.

1. Open `docs/labelling/labels.csv` (40 rows: question, what the agent did, the agent's answer, the rubric). The row order is random and the item ids are opaque, so you do not see which prompt variant produced an answer.
2. Fill the `human_verdict` column with `pass` or `fail` (judge each answer only against its rubric). `human_notes` is optional. Do not edit other columns.
3. Run the calibration against a judge (costs a few cents with the Haiku judge; `simulated:0.5` tests the pipeline for free):
   ```bash
   tg="node packages/cli/dist/bin.js -c examples/support-agent/tracegate.config.mjs"
   $tg judge calibrate --labels docs/labelling/labels.csv --dry-run          # counts only, no judge call
   ANTHROPIC_API_KEY=... $tg judge calibrate --labels docs/labelling/labels.csv --judge anthropic:claude-haiku-5-5 --json experiments/results/judge-calibration.json
   ```
   It prints percent agreement, Cohen's kappa, the confusion matrix and a warning when there are fewer than 40 labels or only one class. Blank rows are skipped and counted; anything other than pass/fail is an error.
4. The mapping from `item_id` to run set and case is in `docs/labelling/labels.key.json`; don't look at it before labelling.

`tracegate judge sheet` builds a new sheet and refuses to overwrite one that already contains verdicts. `docs/samples/judge-pipeline-demo-FAKE.txt` shows the pipeline running on randomly generated labels (meaningless numbers).
