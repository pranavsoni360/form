"""Services package — long-lived components that run alongside the FastAPI app.

Currently:
- job_worker: async job queue worker pool (M3)

Future:
- dispatcher: concurrent call dispatcher with phone-pool min-heap (M4)
- event_bus: in-process pub/sub for SSE (M6)
"""
