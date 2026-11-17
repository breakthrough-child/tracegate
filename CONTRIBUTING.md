# Contributing

Thanks for helping. Tracegate is small on purpose; the bar is correctness and honest claims.

## Setup
```bash
pnpm install
pnpm build
pnpm exec vitest run        # all tests; no API key needed
pnpm lint
```
Node 20+ (22 recommended: the optional SQLite index uses `node:sqlite`). Python 3.9+ for the Python adapter tests.

## Rules
- Statistics code needs a test against a known or hand-computed reference value.
- Anything printed in the README or write-up as a number must come from a saved run in `experiments/results/`.
- Changes to the trace format update `docs/TRACE_SPEC.md`, the JSON Schema in `packages/core/src/schema.ts` and bump `v` only for breaking changes.
- Conventional-style commit messages; one logical change per commit. Releases follow semver; update `CHANGELOG.md`.

## Writing a scorer
See `docs/SCORERS.md`. A scorer is `{ name, score(ctx) }` returning a `ScorerResult` (or a list of them).

## Good first issues
See `ROADMAP.md`.
