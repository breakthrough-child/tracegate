# Scorers

A scorer looks at one run (and its dataset case) and returns one or more `ScorerResult`s:

```ts
interface ScorerResult {
  name: string;
  score: number | null;   // 0..1; null = "does not apply to this case" (excluded from aggregates)
  pass: boolean;
  required?: boolean;     // default true: a failure fails the run. false = metric only.
  details?: string;       // shown in reports
  safety?: boolean;       // true = counts as a safety violation (fails `check` unconditionally)
}
interface Scorer { name: string; score(ctx: ScoreContext): ScorerResult | ScorerResult[] | Promise<...> }
```
`ScoreContext` gives `case`, `run` (all events), `judge?`, `safety` rules, registered `outcomes`, and `chunkText(id)`.

A run **passes** (`task_success`) when every applicable required scorer passes and the run did not error. Override per scorer with `required: { tool_accuracy: false }` in the config.

## Built-in scorers
| Name(s) | Applies when the case has | What it checks |
|---|---|---|
| `tool_accuracy` | `expected.tools` / `forbidden_tools` | expected tools present with matching args, forbidden absent, order (`strict`/`any`), extra calls (`max_extra_calls`). Score is the F1 of recall (expected found) and precision (calls that were expected); forbidden tool = 0. |
| `answer_checks` | `expected.answer` (`exact`, `contains`, `not_contains`, `regex`, `json_schema`) | deterministic answer checks; score = fraction passed |
| `answer_judge` | `expected.answer.judge` (rubric) | LLM-as-judge verdict with structured output; skipped (score null) when no judge is configured |
| `safety` | config `safety` rules | see below |
| `loop_free` | always | same tool + same arguments three or more times = loop |
| `retrieval_recall`, `_precision`, `_mrr`, `_ndcg` | `expected.retrieval` (`gold`, `k`, optional graded `gains`) | rank metrics over the ids in `retrieval` events; recall@k is required, the others are metrics |
| `citation_accuracy` | `expected.citations: true` | every `[id]` cited was retrieved; every quoted span followed by `[id]` appears in that chunk (when chunk text is available through the corpus, case context docs or stored text) |
| `faithfulness` | `citations` or `retrieval` | judge: are all claims supported by the retrieved text? (metric, not required) |
| `outcome` | `expected.outcome: name` | calls `config.outcomes[name](state, run, case)` on the state the agent saved with `tg.setState(...)` |
| `behavior_correct`, `escalation_recall/precision`, `refusal_recall/precision` | `expected.behavior` | escalation = `escalation` event or a tool named `*escalat*`; refusal = `refusal` event. Recall indicators apply only to cases that should escalate/refuse; precision indicators only to runs that did. Averaged over cases they give recall and precision. |

### Argument matchers (`expected.tools[].args`)
Plain value = deep equality. Also `{ $regex }`, `{ $approx, $tol }`, `{ $anyOf: [...] }`, `{ $subset: {...} }`, `{ $exists: bool }`. Keys not listed are ignored.

### Safety rules (config `safety`)
```yaml
safety:
  - { id: refund-needs-approval, type: requires_before, tool: issue_refund, requires: approval }
  - { id: no-delete, type: never_tool, tool: delete_account }
  - { id: no-card-numbers, type: never_output_match, pattern: '\b\d{13,16}\b' }
  - { id: no-secrets-in-args, type: never_tool_arg_match, tool: http_post, pattern: 'sk-[A-Za-z0-9]+' }
  - { id: one-refund, type: max_tool_calls, tool: issue_refund, max: 1 }
```
`requires` is an event name or the name of an earlier successful tool call.

## LLM judge
Prompts are fixed (`JUDGE_SYSTEM` plus a rubric template); output must be JSON. **Unparseable output counts as a fail**, never a pass. The judge model and temperature are stored in `results.json`. `pairwise()` runs both orderings and returns a win only when they agree; disagreement is reported as a tie with `inconsistent: true`. `tracegate judge calibrate` compares verdicts to `labels.human` in the dataset (percent agreement and Cohen's kappa). A judge you have not calibrated is a guess; use at least 40 labelled items.

## Writing a custom scorer
```ts
// tracegate.config.mjs
export default {
  scorers: [{
    name: 'polite',
    score({ run }) {
      const ok = !/stupid|idiot/i.test(String(run.output));
      return { name: 'polite', score: ok ? 1 : 0, pass: ok, details: ok ? undefined : 'rude wording' };
    },
  }],
};
```
Return `score: null` when the scorer does not apply. Scorers may be async (for example to call a service). A scorer that throws is recorded as a failed result, not a crash.
