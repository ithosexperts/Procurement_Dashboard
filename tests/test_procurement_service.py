"""
Unit tests for Procurement Service logic and business rules.
"""
import pytest
from unittest.mock import AsyncMock, patch


@pytest.mark.asyncio
async def test_get_procurement_summary_success():
    """Summary returns correct records, spend, and UoM analysis."""
    mock_agg = {
        "status": "success",
        "data": [{"TotalRecords": 70640, "TotalSpend": "1745447084.31"}],
    }
    mock_sample = {
        "status": "success",
        "data": [
            {
                "DocNum": 1001,
                "Document": "AP Invoice",
                "Row Total (After Doc Disc)": "15000.50",
                "Quantity": "10.0",
                "UoM": "MTR",
            },
            {
                "DocNum": 1002,
                "Document": "AP Credit Memo",
                "Row Total (After Doc Disc)": "-3500.00",
                "Quantity": "2.0",
                "UoM": "MTR",
            },
        ],
    }

    with patch(
        "app.services.procurement_service.api_request",
        new_callable=AsyncMock,
        side_effect=[mock_agg, mock_sample],
    ):
        from app.services.procurement_service import get_procurement_summary

        res = await get_procurement_summary(sample_limit=2)

    assert res["record_count"] == 70640
    assert res["total_spend"] == pytest.approx(1745447084.31)
    assert res["currency"] == "INR"
    assert res["error"] is None
    assert len(res["sample_records"]) == 2
    assert len(res["uom_summary"]) == 1
    assert res["uom_summary"][0]["uom"] == "MTR"
    assert res["uom_summary"][0]["total_quantity"] == pytest.approx(12.0)


@pytest.mark.asyncio
async def test_credit_memos_retain_negative_spend():
    """Credit memos must not be converted to positive spend."""
    mock_agg = {
        "status": "success",
        "data": [{"TotalRecords": 2, "TotalSpend": "6500.00"}],
    }
    mock_sample = {
        "status": "success",
        "data": [
            {"Document": "AP Invoice", "Row Total (After Doc Disc)": "10000.00"},
            {"Document": "AP Credit Memo", "Row Total (After Doc Disc)": "-3500.00"},
        ],
    }

    with patch(
        "app.services.procurement_service.api_request",
        new_callable=AsyncMock,
        side_effect=[mock_agg, mock_sample],
    ):
        from app.services.procurement_service import get_procurement_summary

        res = await get_procurement_summary()

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
        from app.services.procurement_service import get_procurement_summary

        res = await get_procurement_summary()

    assert res["record_count"] == 0
    assert res["total_spend"] == 0.0
    assert "Connection timeout" in res["error"]
