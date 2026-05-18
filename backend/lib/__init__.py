"""Backend support libraries — small, focused, reusable.

Modules:
- logging_config: structured JSON logging + correlation-ID propagation (M1)
- notifier:       Discord webhook alerts with rate limiting (M1)

Future:
- circuit_breaker, retry, metrics (M5)
- event_bus (M6 if dashboards need it)
"""
