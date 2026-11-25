# OpsDesk dogfood example

Scores recorded eval runs of [OpsDesk](https://github.com/breakthrough-child/OpsDesk) (a customer-ops agent by the same author) with Tracegate. Runs without an API key and without OpsDesk itself: the converted traces are committed under `.tracegate/`.

```bash
tg="node packages/cli/dist/bin.js -c examples/opsdesk/tracegate.config.mjs"
for s in mock-v1 mock-v3 real-haiku; do $tg score $s; done
$tg check --baseline opsdesk-mock-v3 --candidate mock-v3   # passes
$tg check --baseline opsdesk-mock-v3 --candidate mock-v1   # exits 1: task_success regressed
```

## What the three run sets are
| run set | what | simulated? |
|---|---|---|
| `mock-v1` | OpsDesk's first rule-based version | yes (rule engine, no LLM) |
| `mock-v3` | its current rule-based version | yes |
| `real-haiku` | one trial with claude-haiku-5-5, run by OpsDesk | no |

`import.mjs` regenerates everything from an OpsDesk checkout (`node examples/opsdesk/import.mjs ../OpsDesk`); it makes no network calls.

## Results (saved in `docs/samples/opsdesk-check.md`)
- Candidate `mock-v1` against baseline `mock-v3` (a "someone reverted the improvements" scenario, not a real pull request): task_success 0.874 → 0.703, paired-bootstrap 95% CI −0.252 to −0.090, gate fails. 111 cases, **1 trial per case**.
- OpsDesk's own scorer reports 80/114 and 100/114 passes for these two versions on its full case list; Tracegate's re-scoring of the 111 shared cases gives 78 and 97, the same ordering.

## Limits
- OpsDesk stores per-case outcomes (tools used, gated actions, escalation, reply, tokens, cost, latency), not raw model requests, so these traces **cannot be strictly replayed**, and tool arguments and per-call token splits are not available.
- One trial per case: run-to-run noise is not estimated, and Tracegate says so.
- The `opsdesk_policy` outcome check re-implements only part of OpsDesk's own checks (intent, approval gates, escalation, citation).
- `real-haiku` is a single run: do not read its gap to the mock versions as a model-quality result.
