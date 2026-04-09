"""
FastAPI router for the investigation agent.
Mounted on the existing fraud-engine app at /investigate.
"""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("agent.api")

router = APIRouter(prefix="/investigate", tags=["Investigation Agent"])


class InvestigateRequest(BaseModel):
    transaction_id: int
    trigger: Literal["BLOCK", "REVIEW", "MANUAL"] = "MANUAL"


class InvestigateResponse(BaseModel):
    transaction_id: int
    verdict: dict
    audit_trail: list[dict] = Field(default_factory=list)
    iterations_used: int


@router.post("", response_model=InvestigateResponse)
async def investigate(req: InvestigateRequest):
    """
    Run a fraud investigation on a transaction.

    The agent collects context from NestJS endpoints, runs a ReAct reasoning
    loop with LLM + tools, and produces a structured verdict.
    """
    # Lazy import to avoid loading LangGraph at module import time
    # (allows fraud engine to start without OPENAI_API_KEY for /check endpoint)
    from agent.graph import investigation_graph

    try:
        result = await investigation_graph.ainvoke({
            "transaction_id": req.transaction_id,
            "trigger": req.trigger,
        })
    except Exception as e:
        logger.exception(f"Investigation failed for transaction {req.transaction_id}")
        raise HTTPException(
            status_code=500,
            detail=f"Investigation failed: {str(e)}",
        )

    verdict = result.get("verdict")
    if not verdict:
        raise HTTPException(
            status_code=500,
            detail="Agent produced no verdict",
        )

    return InvestigateResponse(
        transaction_id=req.transaction_id,
        verdict=verdict,
        audit_trail=result.get("audit_trail", []),
        iterations_used=result.get("iteration", 0),
    )


@router.get("/health")
async def agent_health():
    """Health check for the investigation agent subsystem."""
    return {"status": "healthy", "service": "investigation-agent"}
