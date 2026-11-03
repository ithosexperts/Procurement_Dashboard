"""
Unit tests for Procurement Service logic and business rules.
"""
import pytest
import pandas as pd
from unittest.mock import AsyncMock, patch
from app.services.procurement_service import (
    ProcurementDataStore,
    get_procurement_summary,
    SPEND_COL,
    QTY_COL,
    UOM_COL,
)


@pytest.fixture(autouse=True)
def reset_store():
    store = ProcurementDataStore.get_instance()
    old_df = store._df
    old_records = store._total_records
    old_as_of = store._data_as_of
    store._df = None
    store._total_records = 0
    yield
    store._df = old_df
    store._total_records = old_records
    store._data_as_of = old_as_of


@pytest.mark.asyncio
async def test_get_procurement_summary_success():
    """Summary returns correct records, spend, and formatted amounts."""
    mock_batch = {
        "status": "success",
        "totalRows": 2,
        "totalPages": 1,
        "data": [
            {
                "DocNum": 1001,
                "Document": "AP Invoice",
                SPEND_COL: "15000.50",
                QTY_COL: "10.0",
                UOM_COL: "MTR",
            },
            {
                "DocNum": 1002,
                "Document": "AP Credit Memo",
                SPEND_COL: "-3500.00",
                QTY_COL: "-2.0",
                UOM_COL: "MTR",
            },
        ],
    }

    with patch(
        "app.services.procurement_service.api_request",
        new_callable=AsyncMock,
        return_value=mock_batch,
    ):
        res = await get_procurement_summary(sample_limit=2, force_refresh=True)

    assert res["record_count"] == 2
    assert res["total_spend"] == pytest.approx(11500.50)
    assert res["currency"] == "INR"
    assert res["error"] is None
    assert len(res["sample_records"]) == 2


@pytest.mark.asyncio
async def test_credit_memos_retain_negative_spend():
    """Credit memos must not be converted to positive spend."""
    mock_batch = {
        "status": "success",
        "totalRows": 2,
        "totalPages": 1,
        "data": [
            {"Document": "AP Invoice", SPEND_COL: "10000.00"},
            {"Document": "AP Credit Memo", SPEND_COL: "-3500.00"},
        ],
    }

    with patch(
        "app.services.procurement_service.api_request",
        new_callable=AsyncMock,
        return_value=mock_batch,
    ):
        res = await get_procurement_summary(force_refresh=True)

    # Net spend should reflect 10000 - 3500 = 6500
    assert res["total_spend"] == pytest.approx(6500.00)


@pytest.mark.asyncio
async def test_api_error_handled_gracefully():
    """Service returns error message instead of raising unhandled exception."""
    from app.api.client import ApiError

    with patch(
        "app.services.procurement_service.api_request",
        new_callable=AsyncMock,
        side_effect=ApiError("Connection timeout", status_code=504),
    ):
        res = await get_procurement_summary(force_refresh=True)

    assert res["record_count"] == 0
    assert res["total_spend"] == 0.0
    assert "Connection timeout" in str(res["error"])
