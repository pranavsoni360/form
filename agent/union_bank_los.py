# agent/union_bank_los.py
# Entry point for the Union Bank account-opening agent.
# All logic lives in agent_core.py, session.py, tools.py, prompts_account.py, config.py.
import os
import logging
import time

from dotenv import load_dotenv
from livekit.agents import WorkerOptions, cli

from agent_core import entrypoint

load_dotenv(".env.local")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

AGENT_NAME = os.getenv("UNION_BANK_AGENT_NAME", "union-bank-account-opening")

if __name__ == "__main__":
    while True:
        try:
            logging.getLogger("loan-enquiry-agent").info("Starting Union Bank Account Opening Agent Worker...")
            cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
        except KeyboardInterrupt:
            logging.getLogger("loan-enquiry-agent").info("Worker stopped by user")
            break
        except Exception as e:
            logging.getLogger("loan-enquiry-agent").error(f"Worker crashed: {e}")
            logging.getLogger("loan-enquiry-agent").info("Restarting in 5 seconds...")
            time.sleep(5)
