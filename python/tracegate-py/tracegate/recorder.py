from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

TRACE_VERSION = 1

DEFAULT_REDACTION = {
    "patterns": [
        r"sk-[A-Za-z0-9_-]{16,}",
        r"sk-ant-[A-Za-z0-9_-]{10,}",
        r"AKIA[0-9A-Z]{16}",
        r"ghp_[A-Za-z0-9]{30,}",
        r"Bearer\s+[A-Za-z0-9._-]{16,}",
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    ],
    "keys": ["api_key", "apikey", "authorization", "password", "secret", "token", "x-api-key"],
    "replacement": "[REDACTED]",
}


def make_redactor(rules: Optional[dict] = None) -> Callable[[Any], Any]:
    rules = rules or DEFAULT_REDACTION
    repl = rules.get("replacement", "[REDACTED]")
    pats = [re.compile(p) for p in rules.get("patterns", [])]
    keys = {k.lower() for k in rules.get("keys", [])}

    def walk(v: Any, path: list) -> Any:
        if isinstance(v, str):
            for p in pats:
                v = p.sub(repl, v)
            return v
        if isinstance(v, list):
            return [walk(x, path + [str(i)]) for i, x in enumerate(v)]
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                dotted = ".".join(path + [str(k)]).lower()
                out[k] = repl if (str(k).lower() in keys or dotted in keys) else walk(x, path + [str(k)])
            return out
        return v

    return lambda v: walk(v, [])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _jsonable(x: Any) -> Any:
    """Convert SDK response objects (pydantic models etc.) into plain JSON."""
    if hasattr(x, "model_dump"):
        return x.model_dump()
    if hasattr(x, "to_dict"):
        return x.to_dict()
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    return x


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)


class Recorder:
    """Writes one JSONL file per run into a run-set directory."""

    def __init__(self, out_dir: Optional[str] = None, redaction: Optional[dict] = None, meta: Optional[dict] = None,
                 prices: Optional[dict] = None):
        self.out_dir = out_dir or os.environ.get("TRACEGATE_RUNSET_DIR") or os.path.join(".tracegate", "runs", "python")
        self.redact = make_redactor(redaction)
        self.meta = {"agent": "python", **(meta or {})}
        self.prices = prices or {}
        os.makedirs(self.out_dir, exist_ok=True)

    def run(self, case_id: str, input: Any, trial: int = 0) -> "RunContext":
        return RunContext(self, case_id, input, trial)


class RunContext:
    def __init__(self, rec: Recorder, case_id: str, input: Any, trial: int):
        self.rec, self.case_id, self.input, self.trial = rec, case_id, input, trial
        self.run_id = str(uuid.uuid4())
        self.output: Any = None
        self.state: Any = None
        self._seq = 0
        self._step = -1
        self._t0 = time.time()
        self._fh = None

    def __enter__(self) -> "RunContext":
        path = os.path.join(self.rec.out_dir, f"{_safe(self.case_id)}__t{self.trial}.jsonl")
        self._fh = open(path, "w", encoding="utf-8")
        self._emit({"type": "run_start", "case_id": self.case_id, "trial": self.trial, "input": self.input, "meta": self.rec.meta})
        return self

    def __exit__(self, et, ev, tb) -> bool:
        status, err = ("error", f"{et.__name__}: {ev}") if et else ("ok", None)
        end = {"type": "run_end", "status": status, "output": self.output, "state": self.state,
               "duration_ms": (time.time() - self._t0) * 1000}
        if err:
            end["error"] = err
        self._emit(end)
        self._fh.close()
        return False  # never swallow exceptions

    def _emit(self, ev: dict) -> None:
        self._seq += 1
        full = {"v": TRACE_VERSION, "run_id": self.run_id, "id": f"e{self._seq}", "ts": _now(), **ev}
        if ev["type"] not in ("run_start", "run_end"):
            full["step"] = max(self._step, 0)
        full = {k: v for k, v in full.items() if v is not None}
        self._fh.write(json.dumps(self.rec.redact(full), default=str) + "\n")
        self._fh.flush()

    def event(self, name: str, data: Any = None) -> None:
        self._emit({"type": "event", "name": name, "data": data})

    def set_state(self, state: Any) -> None:
        self.state = state

    def model(self, provider: str, model: str, request: Any, fn: Callable[[], Any],
              usage: Optional[Callable[[Any], Optional[dict]]] = None) -> Any:
        self._step += 1
        t0 = time.time()
        try:
            res = fn()
        except Exception as e:  # noqa: BLE001
            self._emit({"type": "model_call", "provider": provider, "model": model, "request": request,
                        "latency_ms": (time.time() - t0) * 1000, "error": str(e)})
            raise
        u = usage(res) if usage else None
        ev = {"type": "model_call", "provider": provider, "model": model, "request": request, "response": _jsonable(res),
              "latency_ms": (time.time() - t0) * 1000}
        if u:
            ev["usage"] = u
            price = self.rec.prices.get(model)
            if price:
                ev["cost_usd"] = (u["input_tokens"] * price["input"] + u["output_tokens"] * price["output"]) / 1e6
        self._emit(ev)
        return res

    def tool(self, name: str, args: Any, fn: Callable[[Any], Any]) -> Any:
        t0 = time.time()
        try:
            result = fn(args)
        except Exception as e:  # noqa: BLE001
            self._emit({"type": "tool_call", "name": name, "args": args, "error": str(e), "duration_ms": (time.time() - t0) * 1000})
            raise
        self._emit({"type": "tool_call", "name": name, "args": args, "result": _jsonable(result), "duration_ms": (time.time() - t0) * 1000})
        return result

    def retrieval(self, query: str, results: list, k: Optional[int] = None) -> list:
        self._emit({"type": "retrieval", "query": query, "k": k or len(results),
                    "results": [{"id": r["id"], "score": r.get("score"),
                                 "text_hash": hashlib.sha256(r["text"].encode()).hexdigest()[:16] if "text" in r else None}
                                for r in results]})
        return results


def _ns(**kw: Any) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(**kw)


def wrap_anthropic(run: RunContext, client: Any) -> Any:
    """Return an object with messages.create(...) that records every call."""
    def create(**req: Any) -> Any:
        def usage(r: Any) -> Optional[dict]:
            u = getattr(r, "usage", None) or (r.get("usage") if isinstance(r, dict) else None)
            if not u:
                return None
            g = (lambda k: getattr(u, k, None)) if not isinstance(u, dict) else u.get
            return {"input_tokens": g("input_tokens") or 0, "output_tokens": g("output_tokens") or 0}
        return run.model("anthropic", req.get("model", "unknown"), req, lambda: client.messages.create(**req), usage)
    return _ns(messages=_ns(create=create))


def wrap_openai(run: RunContext, client: Any, provider: str = "openai") -> Any:
    """Return an object with chat.completions.create(...) that records every call."""
    def create(**req: Any) -> Any:
        def usage(r: Any) -> Optional[dict]:
            u = getattr(r, "usage", None) or (r.get("usage") if isinstance(r, dict) else None)
            if not u:
                return None
            g = (lambda k: getattr(u, k, None)) if not isinstance(u, dict) else u.get
            return {"input_tokens": g("prompt_tokens") or 0, "output_tokens": g("completion_tokens") or 0}
        return run.model(provider, req.get("model", "unknown"), req, lambda: client.chat.completions.create(**req), usage)
    return _ns(chat=_ns(completions=_ns(create=create)))
