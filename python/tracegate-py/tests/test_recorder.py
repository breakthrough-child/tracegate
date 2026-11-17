import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tracegate import Recorder  # noqa: E402


class RecorderTest(unittest.TestCase):
    def test_records_events_and_redacts(self):
        with tempfile.TemporaryDirectory() as d:
            rec = Recorder(out_dir=d)
            with rec.run("c1", "hello a@b.com") as run:
                run.model("p", "m", {"api_key": "sk-ant-abcdefghijklmn"}, lambda: {"text": "x"})
                run.tool("t", {"a": 1}, lambda a: {"ok": True})
                run.output = "done"
            lines = [json.loads(l) for l in open(os.path.join(d, "c1__t0.jsonl"))]
            self.assertEqual([l["type"] for l in lines], ["run_start", "model_call", "tool_call", "run_end"])
            self.assertEqual(lines[-1]["output"], "done")
            blob = json.dumps(lines)
            self.assertNotIn("abcdefghijklmn", blob)
            self.assertNotIn("a@b.com", blob)

    def test_errors_are_recorded_and_not_swallowed(self):
        with tempfile.TemporaryDirectory() as d:
            rec = Recorder(out_dir=d)
            with self.assertRaises(ValueError):
                with rec.run("c2", "x"):
                    raise ValueError("boom")
            last = json.loads(open(os.path.join(d, "c2__t0.jsonl")).read().strip().split("\n")[-1])
            self.assertEqual(last["status"], "error")


if __name__ == "__main__":
    unittest.main()
