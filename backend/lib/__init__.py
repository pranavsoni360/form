"""Backend support libraries — small, focused, reusable.

Modules:
- logging_config: structured JSON logging + correlation-ID propagation (M1)
- notifier:       Telegram bot alerts with rate limiting (M1)
- retry:          exponential-backoff retry decorator (M5)
- circuit_breaker: CLOSED/OPEN/HALF_OPEN state machine + protect() helper (M5)

Future:
- metrics, event_bus (M6 if dashboards need it)
"""
