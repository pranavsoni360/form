"""Data-fetch providers for the LRS.

Each provider fetches one pillar's raw data keyed on PAN / Aadhaar / phone and
returns a dict of canonical scorecard input_keys. Real Perfios/Karza adapters
(Phase C) and deterministic mock fixtures (Phase B / QA) share the same
`Provider` contract, so the engine and orchestration never change when live
APIs are wired in.

`get_providers()` chooses the bundle: mock when VG_MOCK_MODE is set or provider
API keys are absent; real adapters otherwise.
"""
from __future__ import annotations

import os

from lrs.providers.base import FetchContext, Provider  # noqa: F401


def use_mock() -> bool:
    if os.getenv("VG_MOCK_MODE", "").lower() in ("1", "true", "yes"):
        return True
    # No Perfios/Karza credentials configured → fall back to mock.
    return not (os.getenv("LRS_PERFIOS_API_KEY") or os.getenv("LRS_KARZA_API_KEY"))


def get_providers() -> list[Provider]:
    """Return the ordered list of providers to run for a scoring request."""
    if use_mock():
        from lrs.providers.mock import get_mock_providers
        return get_mock_providers()
    # Phase C: real adapters. Until implemented, fall back to mock so the
    # pipeline stays functional rather than failing hard.
    from lrs.providers.mock import get_mock_providers
    return get_mock_providers()
