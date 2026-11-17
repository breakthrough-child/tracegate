"""Tracegate Python recorder: same JSONL format and redaction rules as the TypeScript packages."""
from .recorder import Recorder, RunContext, wrap_anthropic, wrap_openai, make_redactor, DEFAULT_REDACTION

__all__ = ["Recorder", "RunContext", "wrap_anthropic", "wrap_openai", "make_redactor", "DEFAULT_REDACTION"]
__version__ = "0.1.0"
