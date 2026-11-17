# Tracegate trace format (v1)

One run = one JSONL file; one JSON object per line, in time order. The format is language-agnostic: the TypeScript
recorder, the Python recorder (`python/tracegate-py`) and the OpenTelemetry importer all produce it. The normative JSON Schema is
`TRACE_EVENT_SCHEMA` in `packages/core/src/schema.ts`; `tracegate validate <file.jsonl>` checks a trace against it.

## Files and layout
```
.tracegate/runs/<run-set>/manifest.json       run-set metadata (name, created, mode, git_sha, simulated, ...)
.tracegate/runs/<run-set>/<case>__t<trial>.jsonl   one run
.tracegate/runs/<run-set>/results.json        scored results (written by `tracegate score`)
```

## Common fields
| field | type | notes |
|---|---|---|
| `v` | int | trace format version, currently `1` |
| `type` | string | one of the event types below |
| `run_id` | string | unique per run |
| `id` | string | unique within the run (`e1`, `e2`, ...) |
| `parent_id` | string? | optional link to a parent event |
| `ts` | string | ISO-8601 timestamp |
| `step` | int? | 0-based agent step (index of the model call the event belongs to) |

## Event types
- **`run_start`**: `case_id`, `trial`, `input`, `meta` (`agent`, `model`, `prompt_version`, `git_sha`, `tags`, `simulated`, free-form).
- **`model_call`**: `provider`, `model`, `params` (temperature, max_tokens), `request`, `response`, `usage` (`input_tokens`, `output_tokens`, `cache_read_tokens?`), `cost_usd?`, `latency_ms`, `retries?`, `error?`.
- **`tool_call`**: `name`, `args`, `result?`, `error?`, `duration_ms`.
- **`retrieval`**: `query`, `k?`, `results[]` of `{id, score?, text_hash?, text?}`, `latency_ms?`. Chunk text is hashed by default and stored only when `storeChunkText` is set.
- **`event`**: `name`, `data?`. Free-form markers used by scorers: `approval`, `escalation`, `refusal`.
- **`run_end`**: `status` (`ok` | `error` | `replay_mismatch`), `output`, `state?` (final state snapshot for outcome scorers), `error?`, `duration_ms`.

A well-formed trace starts with exactly one `run_start` and ends with one `run_end`. A missing `run_end` is read as a truncated run with status `error`.

## Redaction
Redaction runs **before** an event is written. Rules (regexes on string values, key names and dotted key paths) are configured in `redaction`; defaults cover API keys, bearer tokens, AWS key ids, GitHub tokens, e-mail addresses and keys named `password`, `secret`, `token`, `authorization`, `api_key`. Redaction is lossy by design.

## Alignment with OpenTelemetry GenAI conventions
| Tracegate | OpenTelemetry GenAI |
|---|---|
| `model_call.provider` | `gen_ai.system` |
| `model_call.model` | `gen_ai.request.model` |
| `model_call.params.temperature` | `gen_ai.request.temperature` |
| `usage.input_tokens` / `output_tokens` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` |
| `tool_call.name` / `args` / `result` | `gen_ai.tool.name` / `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` |
| `retrieval.query` | `gen_ai.retrieval.query.text` |
| run | span with `gen_ai.operation.name = invoke_agent` |

**Deviations:** Tracegate stores full `request` and `response` bodies (OTel keeps these in optional events), flattens a run into one ordered event list instead of a span tree (parent links are optional), and adds `cost_usd`, `case_id`, `trial` and `state`, which have no OTel equivalent. The GenAI conventions are still evolving; the exporter maps the attributes in the table and puts everything else under `tracegate.*`.

## Versioning
`v` increases only for breaking changes. Readers must ignore unknown fields.
