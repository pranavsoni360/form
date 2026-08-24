# agent/guarantor_consent.py
# Entry point for the Guarantor Consent agent.
# All logic lives in agent_core.py, session.py, tools.py, prompts_guarantor.py, config.py.
import os
import logging
import time

from dotenv import load_dotenv

load_dotenv(".env.local")  # must run before local module imports that call os.getenv()

from livekit.agents import WorkerOptions, cli
from agent_core import entrypoint

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

AGENT_NAME = os.getenv("GUARANTOR_AGENT_NAME", "guarantor-consent")
# Each worker opens its own HTTP health-check server. Two workers on the same
# host MUST use different ports or the second one fails with
# `OSError 10048: only one usage of each socket address ... is normally permitted`.
# Union Bank → 8081, Pusad loan agent → 8082, Guarantor consent → 8083.
AGENT_HTTP_PORT = int(os.getenv("GUARANTOR_AGENT_PORT", "8083"))
# Loopback-only: the worker dials OUT to LiveKit, nothing dials in. See the
# note in los_updated.py. Override with AGENT_HTTP_HOST.
AGENT_HTTP_HOST = os.getenv("AGENT_HTTP_HOST", "127.0.0.1")

if __name__ == "__main__":
    while True:
        try:
            logging.getLogger("loan-enquiry-agent").info(
                f"Starting Guarantor Consent Agent Worker on {AGENT_HTTP_HOST}:{AGENT_HTTP_PORT}..."
            )
            cli.run_app(WorkerOptions(
                entrypoint_fnc=entrypoint,
                agent_name=AGENT_NAME,
                host=AGENT_HTTP_HOST,
                port=AGENT_HTTP_PORT,
            ))
        except KeyboardInterrupt:
            logging.getLogger("loan-enquiry-agent").info("Worker stopped by user")
            break
        except Exception as e:
            logging.getLogger("loan-enquiry-agent").error(f"Worker crashed: {e}")
            logging.getLogger("loan-enquiry-agent").info("Restarting in 5 seconds...")
            time.sleep(5)
