# backend/agent_routes.py
# Thin router — wires sub-routers from backend/agent/ package.
# main.py imports: router, set_db_pool, agent_startup, agent_shutdown
from fastapi import APIRouter

from agent.state import set_db_pool
from agent.batch import router as _batch_router, agent_startup, agent_shutdown
from agent.transcript import router as _transcript_router
from agent.whatsapp import router as _whatsapp_router
from agent.callbacks import router as _callbacks_router
from agent.calls import router as _calls_router

router = APIRouter(prefix="/api/agent", tags=["agent"])
router.include_router(_batch_router)
router.include_router(_transcript_router)
router.include_router(_whatsapp_router)
router.include_router(_callbacks_router)
router.include_router(_calls_router)

__all__ = ["router", "set_db_pool", "agent_startup", "agent_shutdown"]
