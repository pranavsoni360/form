# scripts/verify_guarantor_claim_release.py
"""Standalone checks for the two correctness invariants that protect the
running system: (1) only one tick claims a pending row, (2) the trunk is
always released — even when LiveKit/SIP raises. Uses in-memory fakes; no DB
or LiveKit needed. Run: python scripts/verify_guarantor_claim_release.py
"""
import asyncio, sys, types

# --- fake db_pool ---
class FakePool:
    def __init__(self): self.status = "pending"; self.execs = []
    async def fetchval(self, q, *a):
        if "UPDATE guarantor_consent_calls" in q and "status='calling'" in q:
            if self.status == "pending":
                self.status = "calling"; return a[0]
            return None
        if "SELECT status" in q:
            return "completed"
        return None
    async def execute(self, q, *a): self.execs.append(q)

released = {"called": False, "success": None}

async def fake_acquire(pool, *a, **k): return {"trunk_id": "t1", "phone_number": "+1999"}
async def fake_release(pool, trunk, success): released["called"] = True; released["success"] = success

# inject fakes into the module under test
import importlib
sys.modules["services"] = types.ModuleType("services")
disp_pkg = types.ModuleType("services.dispatcher")
disp_pkg._acquire_trunk_from_db = fake_acquire
disp_pkg._release_trunk_to_db = fake_release
sys.modules["services.dispatcher"] = disp_pkg

# fake livekit api that raises on create_room → forces the except+finally path
lk_api = types.ModuleType("api"); livekit_mod = types.ModuleType("livekit")
class _Boom:
    def __getattr__(self, n): raise RuntimeError("livekit down")
class _FakeAPI:
    def __init__(self, **k): self.room=_Boom()
    async def aclose(self): pass
lk_api.LiveKitAPI = _FakeAPI
livekit_mod.api = lk_api
sys.modules["livekit"] = livekit_mod
sys.modules["livekit.api"] = lk_api

import os
os.environ.setdefault("LIVEKIT_URL","x"); os.environ.setdefault("LIVEKIT_API_KEY","x"); os.environ.setdefault("LIVEKIT_API_SECRET","x")

# import target after fakes are in place
sys.path.insert(0, "backend")
dispatch = importlib.import_module("guarantor.dispatch")

async def main():
    pool = FakePool()
    row = {"id":"r1","guarantor_phone":"9876543210","guarantor_name":"G",
           "bank_id":None,"language":"hindi","bank_name":"ABC","borrower_name":"B",
           "loan_amount":None,"retry_count":0}
    # claim succeeds once
    assert await dispatch._claim(pool, "r1") is True
    assert await dispatch._claim(pool, "r1") is False, "second claim must fail"
    # full dispatch with LiveKit raising → must still release trunk
    pool2 = FakePool()
    await dispatch.dispatch_guarantor_call(pool2, row)
    assert released["called"] is True, "TRUNK LEAK: release not called on exception"
    print("OK: claim-once + finally-release invariants hold")

asyncio.run(main())
