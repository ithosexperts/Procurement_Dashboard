"""
Procurement data service.

Fetches data from VD_Procurement_Dashboard via the company API (apiv2.php)
and computes core metrics according to business data rules:

- Spend = Row Total (After Doc Disc)
- Credit memos must retain negative spend
- Quantity must be analysed separately by UoM
- Spend is in INR
- GST and document-header freight are excluded
- Source business rules are strictly preserved
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from app.api.client import api_request, ApiError
from app.auth.request_context import get_current_database_target
from app.config import settings

logger = logging.getLogger(__name__)

SPEND_COLUMN = "Row Total (After Doc Disc)"
DOCUMENT_COLUMN = "Document"
QUANTITY_COLUMN = "Quantity"
UOM_COLUMN = "UoM"


async def get_procurement_summary(sample_limit: int = 50) -> dict[str, Any]:
    """
    Retrieve procurement summary metrics and sample data from VD_Procurement_Dashboard.

    Returns:
    {
        "record_count": int,          # Total database records (e.g. 70,640)
        "total_spend": float,         # Total Spend in INR (credit memos negative)
        "total_spend_formatted": str, # e.g. "₹1,745,447,084.31"
        "currency": "INR",
        "data_as_of": str,            # ISO-8601 UTC timestamp
        "database": str,              # e.g. "Test_OperationsDB"
        "sample_records": list[dict], # Recent records for UI/validation
        "columns": list[str],         # Columns available in the view
        "uom_summary": list[dict],    # Quantity grouped by UoM (sample)
        "error": str | None,
    }
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    active_db = get_current_database_target() or settings.api_database

    try:
        # 1. Database-level aggregation for exact record count and total spend
        agg_result = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns=f"COUNT(DocNum) as TotalRecords, SUM([{SPEND_COLUMN}]) as TotalSpend",
            limit=1,
            database=active_db,
        )

        agg_data = agg_result.get("data", [])
        total_records = 0
        total_spend = 0.0

        if agg_data and isinstance(agg_data[0], dict):
            row = agg_data[0]
            try:
                total_records = int(row.get("TotalRecords") or 0)
            except (ValueError, TypeError):
                total_records = 0

            try:
                raw_spend = row.get("TotalSpend")
                total_spend = float(raw_spend) if raw_spend is not None else 0.0
            except (ValueError, TypeError):
                total_spend = 0.0

        # Fallback to totalRows if COUNT aggregation returned 0
        if total_records == 0:
            total_records = int(agg_result.get("totalRows") or 0)

        # 2. Retrieve sample records for column validation and UoM analysis
        sample_result = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns="*",
            limit=sample_limit,
            database=active_db,
        )

        sample_records = sample_result.get("data", [])
        available_columns: list[str] = []
        uom_summary: list[dict[str, Any]] = []

        if sample_records:
            available_columns = list(sample_records[0].keys())
            df = pd.DataFrame(sample_records)

            # Analyze Quantity by UoM using Pandas (Business Rule)
            if QUANTITY_COLUMN in df.columns and UOM_COLUMN in df.columns:
                df[QUANTITY_COLUMN] = pd.to_numeric(
                    df[QUANTITY_COLUMN], errors="coerce"
                ).fillna(0.0)
                # Fill null UoMs with 'Unspecified'
                df[UOM_COLUMN] = df[UOM_COLUMN].fillna("Unspecified").replace("", "Unspecified")
                grouped = (
                    df.groupby(UOM_COLUMN)[QUANTITY_COLUMN]
                    .agg(["sum", "count"])
                    .reset_index()
                )
                grouped.columns = ["uom", "total_quantity", "record_count"]
                uom_summary = grouped.to_dict(orient="records")

            # Validate that if sample spend column exists, numeric casting retains negatives
            if SPEND_COLUMN in df.columns:
                df[SPEND_COLUMN] = pd.to_numeric(
                    df[SPEND_COLUMN], errors="coerce"
                ).fillna(0.0)

        formatted_spend = f"₹{total_spend:,.2f}"

        logger.info(
            "Procurement summary: %d records, Spend=%s (db=%s)",
            total_records,
            formatted_spend,
            active_db,
        )

        return {
            "record_count": total_records,
            "total_spend": total_spend,
            "total_spend_formatted": formatted_spend,
            "currency": "INR",
            "data_as_of": now_iso,
            "database": active_db,
            "sample_records": sample_records,
            "columns": available_columns,
            "uom_summary": uom_summary,
            "error": None,
        }

    except ApiError as exc:
        logger.error("Procurement API fetch error: %s", exc)
        return {
            "record_count": 0,
            "total_spend": 0.0,
            "total_spend_formatted": "₹0.00",
            "currency": "INR",
            "data_as_of": now_iso,
            "database": active_db,
            "sample_records": [],
            "columns": [],
            "uom_summary": [],
            "error": str(exc),
        }
    except Exception as exc:
        logger.exception("Unexpected error in procurement service: %s", exc)
        return {
            "record_count": 0,
            "total_spend": 0.0,
            "total_spend_formatted": "₹0.00",
            "currency": "INR",
            "data_as_of": now_iso,
            "database": active_db,
            "sample_records": [],
            "columns": [],
            "uom_summary": [],
            "error": "Failed to load procurement metrics. Please verify API gateway status.",
        }
