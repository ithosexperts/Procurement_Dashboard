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


@pytest.mark.asyncio
async def test_float64_monetary_precision_preserved():
    """Verify that spend amounts exceeding 300 million retain sub-rupee/paise precision without float32 truncation."""
    exact_spend = 305837164.522350264
    mock_batch = {
        "status": "success",
        "totalRows": 1,
        "totalPages": 1,
        "data": [
            {
                "DocNum": 9999,
                "Document": "AP Invoice",
                SPEND_COL: f"{exact_spend:.9f}",
                QTY_COL: "10.0",
                UOM_COL: "MTR",
            }
        ],
    }

    with patch("app.services.procurement_service.api_request", new_callable=AsyncMock, return_value=mock_batch):
        res = await get_procurement_summary(sample_limit=1, force_refresh=True)

    # In float32, 305837164.52235 would round to 305837200.0 or lose paise precision.
    # In float64, it must remain exact to within 1e-5.
    assert abs(res["total_spend"] - exact_spend) < 1e-4
    assert res["total_spend_formatted"] == "₹305,837,164.52"


@pytest.mark.asyncio
async def test_load_data_uses_stable_order_by():
    """Verify that _load_data passes deterministic order_by to api_request on all batches."""
    store = ProcurementDataStore.get_instance()
    mock_batch = {
        "status": "success",
        "totalRows": 25,
        "totalPages": 2,
        "data": [{"DocNum": 1, "Document": "AP Invoice", SPEND_COL: "100.0", QTY_COL: "1.0", UOM_COL: "MTR"}],
    }

    recorded_calls = []

    async def _mock_api(*args, **kwargs):
        recorded_calls.append(kwargs)
        return mock_batch

    with patch("app.services.procurement_service.api_request", side_effect=_mock_api):
        await store._load_data()

    assert len(recorded_calls) >= 2
    for call_kwargs in recorded_calls:
        assert "order_by" in call_kwargs
        assert call_kwargs["order_by"] == "DocNum,Document,Quantity,UoM"


def test_client_database_target_defaults_to_operationsdb():
    """Verify that _resolve_database defaults to production OperationsDB."""
    from app.api.client import _resolve_database
    assert _resolve_database() == "OperationsDB"
    assert _resolve_database(None) == "OperationsDB"
    assert _resolve_database("OperationsDB") == "OperationsDB"


@pytest.mark.asyncio
async def test_query_caches_invalidate_on_refresh():
    """Verify that cache keys include dataframe id and clear_query_caches clears all entries."""
    from app.services.procurement_service import (
        clear_query_caches,
        _mask_cache,
        _facet_cache,
        _breakdown_cache,
        query_procurement_data,
    )
    store = ProcurementDataStore.get_instance()
    df1 = pd.DataFrame([{"DocNum": 1, "Document": "AP Invoice", SPEND_COL: 100.0, "Posting Year": 2024, "Posting Month": 1}])
    store._df = df1
    store._total_records = len(df1)

    res1 = await query_procurement_data(granularity="Yearly", measure="Spend", date_basis="Posting Date", filters={"year": ["2024"]})
    assert res1["record_count"] == 1
    assert len(_mask_cache) > 0

    clear_query_caches()
    assert len(_mask_cache) == 0
    assert len(_facet_cache) == 0
    assert len(_breakdown_cache) == 0

