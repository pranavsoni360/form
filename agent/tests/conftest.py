"""Make the agent package importable when running `pytest agent/tests`.

The agent runs as a set of flat scripts from `agent/` as its working directory
(see the systemd units), so its modules import each other by bare name. Tests
live one level down, so we put the agent dir on sys.path to match runtime.
"""
from __future__ import annotations

import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))
