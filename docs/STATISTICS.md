# Statistics: what each test does and when not to trust it

All of this is implemented in `packages/core/src/stats.ts` from first principles (no statistics dependency; logged in `DECISIONS.md`) and tested against hand-computed reference values in `packages/core/test/stats.test.ts`.

## Unit of analysis
The **case** is the unit. A case run for `N` trials gives one number per metric (the mean over its trials). Resampling and tests work over cases, because trials of the same case are correlated. Treating 40 cases × 5 trials as 200 independent observations would give intervals that are too narrow.

## Bootstrap confidence intervals (`bootstrapCI`)
Cases are resampled with replacement (2,000 draws by default, seeded, so reports are reproducible); the 2.5th and 97.5th percentiles of the resampled statistic are the 95% interval.
- Assumes the cases are a representative sample of the situations you care about.
- **Do not trust it** with fewer than ~15 cases, near 0% or 100% (the percentile bootstrap undercovers), or for statistics at the edge of the data such as a p99.

## Paired bootstrap (`pairedBootstrap`)
Baseline and candidate are run on the **same cases**; the per-case differences are resampled. This removes between-case difficulty variation and is far more sensitive than comparing two independent intervals. The reported p-value comes from bootstrapping the mean-centred differences under H0 (mean difference = 0). Effect size is Cohen's d<sub>z</sub> (mean difference over the standard deviation of the differences).
- Assumes cases are exchangeable and the two runs used the same case set.
- **Do not trust it** when most differences are exactly zero and a few are large (tiny effective sample size; see McNemar), or with fewer than `min_cases` (default 10) paired cases: the tool then reports `insufficient_data` instead of a verdict.

## Exact McNemar test (`mcnemarExact`)
For pass/fail: count cases that passed in the baseline but failed in the candidate (`b`) and the reverse (`c`). Under "no change" the discordant pairs split 50/50, so the two-sided p-value is `min(1, 2·P(X ≤ min(b,c)))` with `X ~ Binomial(b+c, 0.5)`. A case counts as passing when more than half its trials pass. Exact, so valid for small counts. Reference value in the tests: b=2, c=10 gives p = 158/4096 ≈ 0.0386.
- Ignores cases that did not change, so it needs discordant pairs; with `b+c < 6` it can never reach p < 0.05.
- Throws away trial-level information; the paired bootstrap on case pass rates uses it.

## pass@k (`passAtK`)
Unbiased estimator `1 − C(n−c, k)/C(n, k)` for `n` trials with `c` passes (Chen et al., 2021). Reported per run set with `k = min(trials, 3)`. It answers "does at least one of k attempts succeed", which is a different question from reliability; look at pass rate and flakiness for that.

## Flakiness
A case is flaky when its pass/fail outcome differs between trials of one run set. With 1 trial, flakiness is invisible: that is the point of `--trials`.

## Cohen's kappa (`cohenKappa`)
Judge-versus-human agreement corrected for chance: `(po − pe)/(1 − pe)`. Reference: po=0.7, pe=0.5 gives 0.4.
- **Do not trust it** with few items (the interval is wide: 20 items cannot distinguish 0.5 from 0.8) or very imbalanced labels (kappa collapses even when raw agreement is high; the report prints both).

## The gate's decision rule (`check`)
A gated metric (default `task_success`) is a **regression** when the 95% paired-bootstrap interval of (candidate − baseline) lies entirely below zero **and** the point estimate is at least `tolerance` (default 0.02) worse. For cost, latency and tokens (lower is better) the same rule applies in the other direction with a relative tolerance. It is deliberately conservative: a real but small drop may pass.
- Each gated metric is a separate test; the more metrics you gate, the more false alarms you get (no multiple-comparison correction is applied). Keep `gate_metrics` short.
- 5% nominal error is an upper-bound intuition, not a guarantee. Experiment 2 measures the empirical false-positive rate on the simulated agent (`experiments/results/e2-false-regressions.json`).

## Things the tests cannot fix
Dataset not representative of production; correlated cases (near-duplicates inflate n); a judge that is wrong in the same way every time; non-stationary models (a hosted model updated between baseline and candidate runs looks like a regression in your code); the baseline and candidate being run at different times of day against rate-limited APIs.
