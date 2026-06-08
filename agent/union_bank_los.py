# agent/union_bank_los.py
# Entry point for the Union Bank account-opening agent.
# All logic lives in agent_core.py, session.py, tools.py, prompts_account.py, config.py.
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

AGENT_NAME = os.getenv("UNION_BANK_AGENT_NAME", "union-bank-account-opening")
# Each worker opens its own HTTP health-check server. Two workers on the same
# host MUST use different ports or the second one fails with
# `OSError 10048: only one usage of each socket address ... is normally permitted`.
# Union Bank → 8081 (default), Pusad loan agent → 8082 (see los_updated.py).
AGENT_HTTP_PORT = int(os.getenv("UNION_BANK_AGENT_PORT", "8081"))

if __name__ == "__main__":
    while True:
        try:
            logging.getLogger("loan-enquiry-agent").info(
                f"Starting Union Bank Account Opening Agent Worker on :{AGENT_HTTP_PORT}..."
            )
            cli.run_app(WorkerOptions(
                entrypoint_fnc=entrypoint,
                agent_name=AGENT_NAME,
                port=AGENT_HTTP_PORT,
            ))
        except KeyboardInterrupt:
            logging.getLogger("loan-enquiry-agent").info("Worker stopped by user")
            break
        except Exception as e:
            logging.getLogger("loan-enquiry-agent").error(f"Worker crashed: {e}")
            logging.getLogger("loan-enquiry-agent").info("Restarting in 5 seconds...")
            time.sleep(5)
