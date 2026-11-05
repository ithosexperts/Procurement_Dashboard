"""
Dashboard router – Procurement Dashboard landing page and JSON APIs.
"""
from __future__ import annotations

import logging
from typing import Any
from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse

from app.auth.request_context import get_current_identity
from app.services.procurement_service import (
    data_store,
    get_procurement_summary,
    query_procurement_data,
)
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
            "data_as_of": summary["data_as_of_formatted"],
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


@router.get("/api/procurement/dataset")
async def procurement_dataset_api(
    request: Request,
    refresh: bool = Query(False, description="Force refresh from upstream API"),
):
    """
    Trigger or check in-memory dataset load (Rules DL1–DL4).
    Only queries the database when opening or clicking 'Refresh Data'.
    """
    try:
        df = await data_store.get_dataframe(force_refresh=refresh)
        return JSONResponse({
            "status": "success",
            "record_count": len(df),
            "data_as_of": data_store.data_as_of.isoformat() if data_store.data_as_of else "",
            "data_as_of_formatted": data_store.data_as_of_formatted,
        })
    except Exception as exc:
        logger.exception("Failed to load procurement dataset: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(exc)},
        )


@router.post("/api/procurement/query")
async def procurement_query_api(
    request: Request,
    payload: dict[str, Any] = Body(...),
):
    """
    Query the in-memory dataset with Stage 1, Stage 2, and Stage 3 active filters.
    Returns:
    - Summary metrics
    - 2-way cascading filter options with matching row counts (FT5, FT6, FT7)
    - Main chart period bars (CH1, CH2, FL5, FL6, FL7)
    - 10 horizontal breakdown charts (CH3–CH10)
    - 13-column detail table page (TB1–TB5)
    """
    granularity = payload.get("granularity", "Monthly")
    measure = payload.get("measure", "Spend")
    date_basis = payload.get("date_basis", "Posting Date")
    filters = payload.get("filters", {})
    page = int(payload.get("page", 1))
    page_size = int(payload.get("page_size", 50))
    sort_column = payload.get("sort_column", "Posting Date")
    sort_direction = payload.get("sort_direction", "desc")
    intent = payload.get("intent", "all")

    result = await query_procurement_data(
        granularity=granularity,
        measure=measure,
        date_basis=date_basis,
        filters=filters,
        page=page,
        page_size=page_size,
        sort_column=sort_column,
        sort_direction=sort_direction,
        intent=intent,
    )

    return JSONResponse(result)
