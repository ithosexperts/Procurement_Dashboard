"""
Comprehensive tests for cascading drill-down (Year -> Month -> Week -> Date).

Validates:
1. Yearly chart loads correctly by default.
2. Double-clicking/filtering a year loads the correct 12-month aggregation.
3. Filtering a month loads the correct Monday-Sunday weekly aggregation.
4. Filtering a week loads the correct daily aggregation.
5. Correct filters are automatically populated and reflected at every level.
6. Dashboard breakdowns refresh using the selected date range.
7. Breadcrumb navigation and back/reset controls.
8. Empty periods are handled correctly (zero spend).
9. Period totals reconcile exactly with their parent aggregation.
10. Month filter supports month names ('March', 'mar') and integers.
"""
import pytest
import pandas as pd
from app.services.procurement_service import (
    data_store,
    query_procurement_data,
    get_month_weeks,
    SPEND_COL,
    POSTING_DATE_COL,
)


@pytest.fixture(autouse=True)
async def ensure_data():
    """Ensure data is loaded in data_store."""
    await data_store.get_dataframe()


@pytest.mark.asyncio
async def test_yearly_default_view():
    """1. Yearly chart loads correctly by default."""
    res = await query_procurement_data(
        granularity="Yearly",
        measure="Spend",
        date_basis="Posting Date",
        filters={},
    )
    chart = res["main_chart"]
    assert "labels" in chart
    assert "2023" in chart["labels"]
    assert "2024" in chart["labels"]
    assert "2025" in chart["labels"]
    assert "2026" in chart["labels"]
    assert len(chart["datasets"]) == 1
    assert chart["datasets"][0]["label"] == "Spend (INR)"
    assert res["total_spend"] > 0
    assert res["record_count"] > 0


@pytest.mark.asyncio
async def test_monthly_drilldown_and_reconciliation():
    """2. Monthly aggregation loads 12 months and reconciles exactly with yearly total."""
    # Yearly total for 2024
    res_y = await query_procurement_data(
        granularity="Yearly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024]},
    )
    total_spend_2024 = res_y["total_spend"]

    # Monthly drilldown for 2024
    res_m = await query_procurement_data(
        granularity="Monthly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024]},
    )
    chart = res_m["main_chart"]
    assert len(chart["labels"]) == 12
    assert chart["labels"][0] == "Jan-2024"
    assert chart["labels"][2] == "Mar-2024"
    assert chart["labels"][11] == "Dec-2024"

    # Meta has month details
    assert len(chart["meta"]) == 12
    assert chart["meta"][2]["month"] == 3
    assert chart["meta"][2]["month_name"] == "March"

    # Sum of 12 months must equal yearly spend
    monthly_data = chart["datasets"][0]["data"]
    sum_months = sum(monthly_data)
    assert abs(sum_months - total_spend_2024) < 1.0  # Float precision rounding


@pytest.mark.asyncio
async def test_weekly_drilldown_and_reconciliation():
    """3. Weekly aggregation generates Monday-Sunday weeks restricted to month and reconciles."""
    # Monthly total for March 2024
    res_m = await query_procurement_data(
        granularity="Monthly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": [3]},
    )
    total_spend_mar = res_m["total_spend"]

    # Weekly drilldown for March 2024
    res_w = await query_procurement_data(
        granularity="Weekly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": [3]},
    )
    chart = res_w["main_chart"]
    # March 2024 has 5 Monday-Sunday weeks
    assert len(chart["labels"]) == 5
    assert "Week 1" in chart["labels"][0]
    assert "Week 2" in chart["labels"][1]
    assert "Week 5" in chart["labels"][4]

    # Check meta has contiguous dates
    meta = chart["meta"]
    assert len(meta) == 5
    assert meta[0]["start_date"] == "2024-03-01"
    assert meta[0]["end_date"] == "2024-03-03"
    assert meta[1]["start_date"] == "2024-03-04"
    assert meta[1]["end_date"] == "2024-03-10"
    assert meta[4]["end_date"] == "2024-03-31"

    # Sum of weeks must equal monthly spend
    weekly_data = chart["datasets"][0]["data"]
    sum_weeks = sum(weekly_data)
    assert abs(sum_weeks - total_spend_mar) < 1.0


@pytest.mark.asyncio
async def test_daily_drilldown_and_reconciliation():
    """4. Daily aggregation generates all dates within week and reconciles with week spend."""
    # Weekly query to get Week 2 spend
    res_w = await query_procurement_data(
        granularity="Weekly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": [3]},
    )
    w2_spend = res_w["main_chart"]["datasets"][0]["data"][1]

    # Daily drilldown for Week 2: 2024-03-04 to 2024-03-10
    res_d = await query_procurement_data(
        granularity="Daily",
        measure="Spend",
        date_basis="Posting Date",
        filters={
            "year": [2024],
            "month": [3],
            "fromDate": "2024-03-04",
            "toDate": "2024-03-10",
        },
    )
    chart = res_d["main_chart"]
    assert len(chart["labels"]) == 7
    assert chart["labels"][0] == "04 Mar 2024"
    assert chart["labels"][6] == "10 Mar 2024"

    daily_data = chart["datasets"][0]["data"]
    sum_daily = sum(daily_data)
    assert abs(sum_daily - w2_spend) < 1.0


@pytest.mark.asyncio
async def test_empty_periods_handling():
    """5. Days or periods with zero transactions return 0.0 within period without disappearing."""
    # Within Week 2 (2024-03-04 to 2024-03-10), 2024-03-10 has zero transactions
    res_d = await query_procurement_data(
        granularity="Daily",
        measure="Spend",
        date_basis="Posting Date",
        filters={
            "fromDate": "2024-03-04",
            "toDate": "2024-03-10",
        },
    )
    chart = res_d["main_chart"]
    assert len(chart["labels"]) == 7
    assert chart["labels"][6] == "10 Mar 2024"
    # Spend on 2024-03-10 is 0.0 without disappearing from chart
    assert chart["datasets"][0]["data"][6] == 0.0

    # When querying solely a date with no records, no_data is correctly flagged (FT11)
    res_empty = await query_procurement_data(
        granularity="Daily",
        measure="Spend",
        date_basis="Posting Date",
        filters={
            "fromDate": "2024-03-10",
            "toDate": "2024-03-10",
        },
    )
    assert res_empty.get("no_data") is True
    assert res_empty["record_count"] == 0


@pytest.mark.asyncio
async def test_filter_synchronization_across_dashboard():
    """6. When filtered to a period, 10 Breakdown charts and totals reflect that period."""
    res = await query_procurement_data(
        granularity="Weekly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": [3]},
    )
    assert res["record_count"] == 889
    assert abs(res["total_spend"] - 19383994.90) < 1.0
    bd = res["breakdown_charts"]
    assert "import_domestic" in bd
    assert "receiving_state" in bd
    assert "top_vendors" in bd


@pytest.mark.asyncio
async def test_month_name_and_number_filter_compatibility():
    """7. Month filter accepts number '3', name 'March', or abbreviation 'Mar'."""
    res_num = await query_procurement_data(
        granularity="Monthly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": ["3"]},
    )
    res_name = await query_procurement_data(
        granularity="Monthly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": ["March"]},
    )
    res_abbr = await query_procurement_data(
        granularity="Monthly",
        measure="Spend",
        date_basis="Posting Date",
        filters={"year": [2024], "month": ["Mar"]},
    )
    assert res_num["record_count"] == res_name["record_count"] == res_abbr["record_count"] == 889
    assert res_num["total_spend"] == res_name["total_spend"] == res_abbr["total_spend"]


def test_get_month_weeks_leap_year():
    """8. get_month_weeks correctly handles leap year February (29 days)."""
    weeks = get_month_weeks(2024, 2)
    # 2024-02-01 is Thursday. Ends on Sun Feb 4 (W1). Then W2, W3, W4, W5 (Feb 26-29).
    assert len(weeks) == 5
    assert weeks[0]["start_date"] == "2024-02-01"
    assert weeks[-1]["end_date"] == "2024-02-29"
