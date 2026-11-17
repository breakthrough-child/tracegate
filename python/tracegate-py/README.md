# tracegate-py

Python recorder for [Tracegate](../../README.md). Writes the same JSONL trace format as the TypeScript
recorder (see `docs/TRACE_SPEC.md`), with the same redaction defaults, so the `tracegate` CLI can score
traces recorded from Python.

```python
from tracegate import Recorder, wrap_anthropic

rec = Recorder()                      # honours TRACEGATE_RUNSET_DIR (set by `tracegate record`)
with rec.run("case-1", "Where is ORD-1001?") as run:
    client = wrap_anthropic(run, anthropic.Anthropic())
    ...                               # run.tool("lookup_order", args, fn) records tool calls
    run.output = answer
```

Install locally with `pip install -e python/tracegate-py` (not published to PyPI).
