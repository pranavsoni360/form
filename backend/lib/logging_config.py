"""
Structured JSON logging + correlation-ID propagation.

Why:
- Plain-text logs are fine in dev but useless in production: you can't filter,
  aggregate, or correlate across services.
- JSON-per-line is parseable by any log tool (jq, Better Stack, ELK, etc.) and
  preserves field types.
- A correlation ID threaded through one request lets you find "every log line
  for this customer's call" in seconds.

Design:
- One `configure_logging(service_name)` function called ONCE from main.py
  before the FastAPI app is created.
- ContextVar `correlation_id_var` is set by the middleware (see main.py) and
  picked up by `CorrelationFilter` on every log record.
- Falls back gracefully: if python-json-logger isn't installed, drops back to
  plain-text format so the app still starts.
"""

from __future__ import annotations

import contextvars
import logging
import os
import sys


# Per-request correlation ID. Set by correlation_id_middleware in main.py;
# read by CorrelationFilter and injected into every LogRecord.
correlation_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "correlation_id", default=None
)


class CorrelationFilter(logging.Filter):
    """Inject the active correlation_id into every LogRecord as `trace_id`."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = correlation_id_var.get() or "-"
        return True


def _build_json_formatter(service_name: str) -> logging.Formatter:
    """Try to use python-json-logger; fall back to plain text if not available."""
    try:
        from pythonjsonlogger import jsonlogger
    except ImportError:
        # Plain-text fallback — production should always have json logger
        return logging.Formatter(
            "%(asctime)s | %(levelname)-7s | %(name)s | trace=%(trace_id)s | %(message)s"
        )

    class CustomJsonFormatter(jsonlogger.JsonFormatter):
        def add_fields(self, log_record, record, message_dict):
            super().add_fields(log_record, record, message_dict)
            # ECS-style field naming so future Logstash/Better Stack pipelines work
            log_record["@timestamp"] = self.formatTime(record, self.datefmt)
            log_record["log.level"] = record.levelname.lower()
            log_record["service.name"] = service_name
            log_record["trace.id"] = getattr(record, "trace_id", "-")
            # Avoid duplicate `levelname` in the output
            log_record.pop("levelname", None)

    return CustomJsonFormatter(
        "%(message)s %(name)s %(funcName)s %(lineno)d",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )


def configure_logging(service_name: str = "los.backend", level: str | None = None) -> None:
    """Replace the root handler with a single stdout handler that emits JSON
    (or plain text if python-json-logger is missing).

    Safe to call multiple times — clears existing handlers each call. Honors
    LOG_LEVEL env var unless `level` is passed explicitly.
    """
    effective_level = (level or os.getenv("LOG_LEVEL", "INFO")).upper()

    root = logging.getLogger()
    # Clear any handlers set by `logging.basicConfig` so our formatter wins
    root.handlers.clear()
    root.setLevel(effective_level)

    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(_build_json_formatter(service_name))
    handler.addFilter(CorrelationFilter())
    root.addHandler(handler)

    # Quiet some noisy third-party loggers in production
    for noisy in ("asyncio", "httpx", "httpcore", "urllib3", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    logging.getLogger(__name__).info(
        "logging configured", extra={"service": service_name, "level": effective_level}
    )
