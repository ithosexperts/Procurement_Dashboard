"""
Dashboard router – Procurement Dashboard landing page and JSON API.
"""
from __future__ import annotations

import logging
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.auth.request_context import get_current_identity
from app.services.procurement_service import get_procurement_summary
from app.templates_config import templates

logger = logging.getLogger(__name__)

router = APIRouter(tags=["dashboard"])


@router.get("/")
async def index(request: Request):
    """Render the main Procurement Dashboard landing page."""
    user = getattr(request.state, "identity", None) or get_current_identity()
    summary = await get_procurement_summary(sample_limit=15)

    return templates.TemplateResponse(
        request,
        "dashboard/index.html",
        {
            "user": user,
            "record_count": summary["record_count"],
            "total_spend": summary["total_spend"],
            "total_spend_formatted": summary["total_spend_formatted"],
            "data_as_of": summary["data_as_of"],
            "database": summary["database"],
            "sample_records": summary["sample_records"],
            "columns": summary["columns"],
            "uom_summary": summary["uom_summary"],
            "error": summary["error"],
        },
    )


@router.get("/api/procurement/summary")
async def procurement_summary_api(request: Request):
    """JSON API endpoint returning real-time procurement summary metrics."""
    summary = await get_procurement_summary(sample_limit=10)
    return JSONResponse(summary)
