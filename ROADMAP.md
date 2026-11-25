# Roadmap

## Next
- Streaming support in the Anthropic/OpenAI wrappers (record the assembled response).
- Larger real-model experiments (the first small one is in the README), judge agreement against human labels (the labelling sheet is ready, **not yet measured**), rubric-wording effect (**not yet measured**).
- Holm/Bonferroni option for gating several metrics at once.
- Sequential testing so a gate can stop early on a clear regression.
- Verified rendering in Langfuse and Phoenix (OTLP export is only tested against file fixtures today).
- Replay matching modes by tool schema hash so harmless description edits do not break replay.

## Later
- TypeScript-native `tracegate.config.ts` loading without an external loader.
- Dataset import from production logs with PII scanning.
- Native Python scorers; Go/Java recorders.
- Hosted comparison history (the dashboard is local only).

## Good first issues
- Add an `--only-failed` flag to `tracegate view`/`sample` output formats (JSON output).
- `tracegate init --template rag` that scaffolds a retrieval dataset with gold ids.
- A `$startsWith` / `$contains` argument matcher.
- Colour output and a `--no-color` flag for the terminal timeline.
- Add a Gemini or Bedrock judge adapter (`packages/adapters/src/index.ts`).
- Tests for `tracegate otel export --endpoint` against a local HTTP server.
- Markdown report: collapse long failure lists with `<details>`.
- Support `.jsonl` datasets in `tracegate promote` output.
- Windows path tests for run-set names.
