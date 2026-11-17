"""A tiny Python agent with a fake Anthropic-style client, so it runs with no API key.

Usage (from the repo root):
    tracegate record --name py -- python3 python/examples/py_agent.py
    tracegate score py --dataset python/examples/dataset.yaml
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tracegate-py"))
from tracegate import Recorder, wrap_anthropic  # noqa: E402

ORDERS = {"ORD-1001": {"order_id": "ORD-1001", "status": "shipped"}, "ORD-1002": {"order_id": "ORD-1002", "status": "delayed"}}


class FakeAnthropic:
    """Deterministic stand-in: first asks for a lookup, then answers from the tool result."""

    class _Msgs:
        def create(self, **req):
            last = req["messages"][-1]
            if isinstance(last["content"], list):
                status = __import__("json").loads(last["content"][0]["content"])["status"]
                content = [{"type": "text", "text": f"Your order is {status}. Contact me at help@example.com or key sk-ant-abcdefghij12345"}]
                return {"content": content, "usage": {"input_tokens": 60, "output_tokens": 18}}
            oid = next(w for w in req["messages"][0]["content"].split() if w.startswith("ORD-")).strip("?.,")
            content = [{"type": "tool_use", "id": "t1", "name": "lookup_order", "input": {"order_id": oid}}]
            return {"content": content, "usage": {"input_tokens": 40, "output_tokens": 12}}

    messages = _Msgs()


def answer(run, question):
    client = wrap_anthropic(run, FakeAnthropic())
    msgs = [{"role": "user", "content": question}]
    res = client.messages.create(model="claude-sonnet-4", max_tokens=200, messages=msgs)
    use = res["content"][0]
    result = run.tool("lookup_order", use["input"], lambda a: ORDERS[a["order_id"]])
    msgs += [{"role": "assistant", "content": res["content"]},
             {"role": "user", "content": [{"type": "tool_result", "tool_use_id": use["id"], "content": __import__("json").dumps(result)}]}]
    res = client.messages.create(model="claude-sonnet-4", max_tokens=200, messages=msgs)
    return res["content"][0]["text"]


if __name__ == "__main__":
    rec = Recorder(meta={"agent": "py-demo", "model": "claude-sonnet-4", "simulated": True},
                   prices={"claude-sonnet-4": {"input": 3, "output": 15}})
    for case_id, q in [("py-1", "Where is ORD-1001?"), ("py-2", "Where is ORD-1002?")]:
        with rec.run(case_id, q) as run:
            run.output = answer(run, q)
    print("recorded", rec.out_dir)
