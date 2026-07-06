"""Provider contract shared by mock fixtures and real Perfios/Karza adapters."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass
class FetchContext:
    """Everything a provider needs to fetch an applicant's data."""
    pan: str | None
    aadhaar: str | None
    phone: str | None
    app: dict  # the loan_applications row (form-collected fields)


@runtime_checkable
class Provider(Protocol):
    name: str          # e.g. "bureau", "income", "bankstmt", "kyc"
    pillar: str        # scorecard pillar key this provider feeds

    async def fetch(self, ctx: FetchContext) -> dict[str, Any]:
        """Return a dict of canonical scorecard input_keys → values.

        Must NOT raise for a merely-unavailable applicant; return {} instead so
        the engine can re-weight around the missing pillar. Raise only on
        genuine transient errors (network/5xx) so the job worker retries.
        """
        ...
