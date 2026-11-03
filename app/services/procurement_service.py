"""
Procurement Analytics Data Service.

Implements Milestones 3, 4, 5, and 6:
- In-memory dataset caching and thread-safe loading (DL1–DL5)
- Spend calculation (DS3) and Quantity by UoM analysis (DS4)
- Multi-granularity period grouping using SQL Server columns (DS5, DS6, FL5, FL6, FL7)
- Multi-select, two-way cascading (faceted) filters (FT1–FT12)
- Main chart and 10 horizontal breakdown charts (CH1–CH10)
- 13-column detail table with global dataset sorting and 50-row pagination (TB1–TB5)
- Preserves accepted limitations (LM1–LM4) and data quality characteristics (DQ1–DQ4)
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
from typing import Any

import numpy as np
import pandas as pd

from app.api.client import api_request, ApiError
from app.auth.request_context import get_current_database_target
from app.config import settings

logger = logging.getLogger(__name__)

# Column names from SQL View VD_Procurement_Dashboard
SPEND_COL = "Row Total (After Doc Disc)"
QTY_COL = "Quantity"
UOM_COL = "UoM"
DOC_COL = "Document"
CURRENCY_COL = "Doc Currency"
VENDOR_COL = "BP Name"
ITEM_GROUP_COL = "Item Group"
SUB_GROUP1_COL = "Sub Group 1"
SUB_GROUP2_COL = "Sub Group 2"
BRAND_COL = "Brand"
BUYER_COL = "Row Buyer"
PURCHASE_TYPE_COL = "Purchase Type"
VENDOR_GROUP_COL = "Group"
RECEIVING_STATE_COL = "Receiving State"
RECEIVING_CITY_COL = "Receiving City"
POSTING_DATE_COL = "Posting Date"
VENDOR_DOC_DATE_COL = "Vendors Doc Date"

# Item Attributes Columns (Section 2.1)
ITEM_ATTRIBUTE_COLUMNS = [
    "Clamps Min Range mm",
    "Clamps Max Range mm",
    "Hose Assy EC1",
    "Hose Assy EC2",
    "Hose Assy Hose",
    "Hose Assy Hose Guard",
    "Hose Coupling Dash Size",
    "Hose Coupling WP",
    "Hose Fittings Dash Size",
    "Hose Fittings Type",
    "Hose Guard ID mm",
    "Hose Size (mm)",
    "Hose WP (Bar)",
    "Rub Exp Joints ID (mm)",
    "Rub Exp Joints WP (Bar)",
    "Rub Exp Joints Falnge Type",
    "Hose Reel Type",
    "Hose Reel Size",
    "Hose Reel Arms",
    "Hose Reel Hose Type",
]

MONTH_ABBRS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


class ProcurementDataStore:
    """
    In-memory singleton dataset store for VD_Procurement_Dashboard.
    Queries the database ONLY on open or explicit refresh (DL1, DL2, DL3).
    """

    _instance: ProcurementDataStore | None = None

    def __init__(self) -> None:
        self._df: pd.DataFrame | None = None
        self._data_as_of: datetime | None = None
        self._total_records: int = 0
        self._database: str = settings.api_database
        self._lock = asyncio.Lock()

    @classmethod
    def get_instance(cls) -> ProcurementDataStore:
        if cls._instance is None:
            cls._instance = ProcurementDataStore()
        return cls._instance

    @property
    def is_loaded(self) -> bool:
        return self._df is not None and not self._df.empty

    @property
    def total_records(self) -> int:
        return self._total_records

    @property
    def data_as_of(self) -> datetime | None:
        return self._data_as_of

    @property
    def data_as_of_formatted(self) -> str:
        if not self._data_as_of:
            return "--"
        # Format as DD-MMM-YYYY HH:MM (DL4)
        return self._data_as_of.strftime("%d-%b-%Y %H:%M")

    async def get_dataframe(self, force_refresh: bool = False) -> pd.DataFrame:
        """Return the loaded DataFrame, loading or refreshing if required."""
        if self._df is not None and not force_refresh:
            return self._df

        async with self._lock:
            # Double-check inside lock
            if self._df is not None and not force_refresh:
                return self._df
            await self._load_data()
            return self._df

    async def _load_data(self) -> None:
        """Fetch all rows from VD_Procurement_Dashboard via batching."""
        target_db = get_current_database_target() or settings.api_database
        logger.info("Initiating full dataset load from VD_Procurement_Dashboard (%s)", target_db)

        # 1. First fetch page 1 to check totalRows and totalPages
        batch_size = 10000
        first_resp = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns="*",
            page=1,
            limit=batch_size,
            database=target_db,
        )

        total_rows = int(first_resp.get("totalRows", 0))
        total_pages = int(first_resp.get("totalPages", 1))
        all_rows = list(first_resp.get("data", []))

        # 2. Concurrently fetch remaining pages if total_pages > 1
        if total_pages > 1:
            async def _fetch_page(page_num: int):
                resp = await api_request(
                    table="VD_Procurement_Dashboard",
                    action="select",
                    columns="*",
                    page=page_num,
                    limit=batch_size,
                    database=target_db,
                )
                return resp.get("data", [])

            tasks = [_fetch_page(p) for p in range(2, total_pages + 1)]
            results = await asyncio.gather(*tasks)
            for page_data in results:
                all_rows.extend(page_data)

        actual_count = len(all_rows)
        logger.info("Retrieved %d records (reported total: %d)", actual_count, total_rows)

        if actual_count == 0 and total_rows > 0:
            raise ApiError(
                f"Failed to load records: expected {total_rows}, received 0",
                table="VD_Procurement_Dashboard",
            )

        # 3. Build and optimize in-memory DataFrame
        df = pd.DataFrame(all_rows)

        # Numeric conversions
        if SPEND_COL in df.columns:
            df[SPEND_COL] = pd.to_numeric(df[SPEND_COL], errors="coerce").fillna(0.0)

        if QTY_COL in df.columns:
            df[QTY_COL] = pd.to_numeric(df[QTY_COL], errors="coerce").fillna(0.0)

        # Date conversions & formatted display columns
        for date_col, disp_col in [
            (POSTING_DATE_COL, "Posting_Date_Formatted"),
            (VENDOR_DOC_DATE_COL, "Vendor_Doc_Date_Formatted"),
        ]:
            if date_col in df.columns:
                dt_series = pd.to_datetime(df[date_col], errors="coerce")
                df[disp_col] = dt_series.dt.strftime("%d-%b-%Y").fillna("")
                df[f"{date_col}_ISO"] = dt_series.dt.strftime("%Y-%m-%d").fillna("")

        # Handle Period integers
        for p_col in [
            "Posting Year", "Posting Month", "Posting Week", "Posting Day",
            "Vendor Doc Year", "Vendor Doc Month", "Vendor Doc Week", "Vendor Doc Day",
        ]:
            if p_col in df.columns:
                df[p_col] = pd.to_numeric(df[p_col], errors="coerce").fillna(0).astype(int)

        # String normalization (FT9: Blank vs NA)
        # Convert NaN, None, empty string to '(Blank)', keeping literal 'NA' distinct
        categorical_cols = [
            DOC_COL, "Document Type", PURCHASE_TYPE_COL, CURRENCY_COL,
            VENDOR_COL, VENDOR_GROUP_COL, "Industry", "Vendor City", "Vendor State", "Vendor Country",
            BUYER_COL, RECEIVING_STATE_COL, RECEIVING_CITY_COL,
            ITEM_GROUP_COL, SUB_GROUP1_COL, SUB_GROUP2_COL,
            "Item Code", "Item Name", BRAND_COL, "MOC", "Made To Order", UOM_COL,
        ] + ITEM_ATTRIBUTE_COLUMNS

        for col in categorical_cols:
            if col in df.columns:
                df[col] = df[col].astype(str).replace(
                    {"None": "(Blank)", "nan": "(Blank)", "": "(Blank)", "Null": "(Blank)", "null": "(Blank)"}
                )

        # Update store state
        self._df = df
        self._total_records = actual_count
        self._data_as_of = datetime.now(timezone.utc)
        self._database = target_db


# Global singleton access
data_store = ProcurementDataStore.get_instance()


async def get_procurement_summary(sample_limit: int = 50, force_refresh: bool = False) -> dict[str, Any]:
    """Compatibility helper for Milestone 1 health/summary checks."""
    try:
        df = await data_store.get_dataframe(force_refresh=force_refresh)
        total_records = len(df)
        total_spend = float(df[SPEND_COL].sum()) if (SPEND_COL in df.columns and total_records > 0) else 0.0

        return {
            "record_count": total_records,
            "total_spend": total_spend,
            "total_spend_formatted": f"₹{total_spend:,.2f}",
            "currency": "INR",
            "data_as_of": data_store.data_as_of.isoformat() if data_store.data_as_of else "",
            "data_as_of_formatted": data_store.data_as_of_formatted,
            "database": data_store._database,
            "sample_records": df.head(sample_limit).to_dict(orient="records"),
            "columns": list(df.columns),
            "uom_summary": [],
            "error": None,
        }
    except Exception as exc:
        logger.error("get_procurement_summary error: %s", exc)
        return {
            "record_count": 0,
            "total_spend": 0.0,
            "total_spend_formatted": "₹0.00",
            "currency": "INR",
            "data_as_of": "",
            "data_as_of_formatted": "--",
            "database": settings.api_database,
            "sample_records": [],
            "columns": [],
            "uom_summary": [],
            "error": str(exc),
        }


def _apply_filter_condition(
    df: pd.DataFrame,
    col_name: str,
    selected_values: list[str],
) -> pd.Series:
    """Filter condition: OR within the filter (FT3)."""
    if not selected_values or col_name not in df.columns:
        return pd.Series(True, index=df.index)
    return df[col_name].isin(selected_values)


def _get_active_filters_mask(
    df: pd.DataFrame,
    date_basis: str,
    filters: dict[str, Any],
    exclude_key: str | None = None,
) -> pd.Series:
    """
    Build combined boolean mask for active filters with AND across different filters (FT3).
    When exclude_key is given, that filter's condition is omitted for 2-way cascading (FT5).
    """
    mask = pd.Series(True, index=df.index)

    # 1. Period filters
    is_posting = (date_basis == "Posting Date")
    date_col_iso = f"{POSTING_DATE_COL}_ISO" if is_posting else f"{VENDOR_DOC_DATE_COL}_ISO"
    year_col = "Posting Year" if is_posting else "Vendor Doc Year"
    month_col = "Posting Month" if is_posting else "Vendor Doc Month"
    week_col = "Posting Week" if is_posting else "Vendor Doc Week"
    day_col = "Posting Day" if is_posting else "Vendor Doc Day"

    # From Date / To Date calendar range (FT8)
    if exclude_key != "calendar":
        from_date = filters.get("fromDate")
        to_date = filters.get("toDate")
        if from_date and date_col_iso in df.columns:
            mask &= (df[date_col_iso] >= from_date)
        if to_date and date_col_iso in df.columns:
            mask &= (df[date_col_iso] <= to_date)

    # Year
    if exclude_key != "year" and filters.get("year"):
        selected_years = [int(y) for y in filters["year"] if str(y).isdigit()]
        if selected_years:
            mask &= df[year_col].isin(selected_years)

    # Month
    if exclude_key != "month" and filters.get("month"):
        selected_months = [int(m) for m in filters["month"] if str(m).isdigit()]
        if selected_months:
            mask &= df[month_col].isin(selected_months)

    # Week
    if exclude_key != "week" and filters.get("week"):
        selected_weeks = [int(w) for w in filters["week"] if str(w).isdigit()]
        if selected_weeks:
            mask &= df[week_col].isin(selected_weeks)

    # Day
    if exclude_key != "day" and filters.get("day"):
        selected_days = [int(d) for d in filters["day"] if str(d).isdigit()]
        if selected_days:
            mask &= df[day_col].isin(selected_days)

    # Standard Categorical Filters mapping: filter_key -> column_name
    field_mapping = {
        "document": DOC_COL,
        "documentType": "Document Type",
        "purchaseType": PURCHASE_TYPE_COL,
        "docCurrency": CURRENCY_COL,
        "bpName": VENDOR_COL,
        "vendorGroup": VENDOR_GROUP_COL,
        "industry": "Industry",
        "vendorCity": "Vendor City",
        "vendorState": "Vendor State",
        "vendorCountry": "Vendor Country",
        "rowBuyer": BUYER_COL,
        "receivingState": RECEIVING_STATE_COL,
        "receivingCity": RECEIVING_CITY_COL,
        "itemGroup": ITEM_GROUP_COL,
        "subGroup1": SUB_GROUP1_COL,
        "subGroup2": SUB_GROUP2_COL,
        "itemCode": "Item Code",
        "brand": BRAND_COL,
        "moc": "MOC",
        "madeToOrder": "Made To Order",
        "uom": UOM_COL,
    }

    for f_key, col in field_mapping.items():
        if exclude_key != f_key and filters.get(f_key):
            vals = filters[f_key]
            if isinstance(vals, list) and vals:
                mask &= _apply_filter_condition(df, col, vals)

    # Item Attributes (FT1-8)
    item_attrs = filters.get("itemAttributes") or {}
    for attr_col in ITEM_ATTRIBUTE_COLUMNS:
        attr_key = f"attr_{attr_col}"
        if exclude_key != attr_key and item_attrs.get(attr_col):
            vals = item_attrs[attr_col]
            if isinstance(vals, list) and vals:
                mask &= _apply_filter_condition(df, attr_col, vals)

    return mask


async def query_procurement_data(
    granularity: str = "Monthly",
    measure: str = "Spend",
    date_basis: str = "Posting Date",
    filters: dict[str, Any] | None = None,
    page: int = 1,
    page_size: int = 50,
    sort_column: str = "Posting Date",
    sort_direction: str = "desc",
) -> dict[str, Any]:
    """
    Core in-memory query engine:
    - Filters data using active Stage 1, 2, and 3 filters
    - Computes faceted dropdown options and counts (FT5, FT6, FT7)
    - Computes main chart period bars (CH1, CH2, FL5, FL6, FL7)
    - Computes 10 breakdown horizontal bar charts (CH3–CH10)
    - Computes sorted, paginated 13-column detail table (TB1–TB5)
    """
    filters = filters or {}
    df = await data_store.get_dataframe()

    if df.empty:
        return {
            "record_count": 0,
            "total_spend": 0.0,
            "data_as_of": data_store.data_as_of_formatted,
            "main_chart": {"labels": [], "datasets": []},
            "breakdown_charts": {},
            "filter_options": {},
            "table_data": {"rows": [], "total_rows": 0, "page": page, "total_pages": 0},
            "no_data": True,
        }

    # 1. Active selection mask across all filters
    active_mask = _get_active_filters_mask(df, date_basis, filters)
    filtered_df = df[active_mask]
    filtered_count = len(filtered_df)

    # Calculate filtered total spend
    filtered_spend = float(filtered_df[SPEND_COL].sum()) if (SPEND_COL in filtered_df.columns and filtered_count > 0) else 0.0

    # Handle No Data (FT11)
    if filtered_count == 0:
        # Still return filter options computed from each filter's exclusion mask so user can un-select
        filter_options = _compute_filter_options(df, date_basis, filters)
        return {
            "record_count": 0,
            "total_spend": 0.0,
            "total_spend_formatted": "₹0.00",
            "data_as_of": data_store.data_as_of_formatted,
            "main_chart": {"labels": [], "datasets": []},
            "breakdown_charts": {},
            "filter_options": filter_options,
            "table_data": {"rows": [], "total_rows": 0, "page": page, "total_pages": 0},
            "no_data": True,
        }

    # 2. Compute 2-way cascading filter options with matching row counts (FT5, FT6, FT7)
    filter_options = _compute_filter_options(df, date_basis, filters)

    # 3. Main Chart Data (CH1, CH2, FL5, FL6, FL7)
    main_chart = _compute_main_chart(filtered_df, granularity, measure, date_basis)

    # 4. Ten Breakdown Horizontal Bar Charts (CH3–CH10)
    breakdown_charts = _compute_breakdown_charts(filtered_df, measure)

    # 5. Detail Table with Global Sorting & 50-row Pagination (TB1–TB5)
    table_data = _compute_detail_table(filtered_df, page, page_size, sort_column, sort_direction)

    return {
        "record_count": filtered_count,
        "total_spend": filtered_spend,
        "total_spend_formatted": f"₹{filtered_spend:,.2f}",
        "data_as_of": data_store.data_as_of_formatted,
        "main_chart": main_chart,
        "breakdown_charts": breakdown_charts,
        "filter_options": filter_options,
        "table_data": table_data,
        "no_data": False,
    }


def _compute_main_chart(
    df: pd.DataFrame,
    granularity: str,
    measure: str,
    date_basis: str,
) -> dict[str, Any]:
    """Generate main vertical bar chart grouping according to Rules FL5, FL6, CH1, CH2."""
    is_posting = (date_basis == "Posting Date")
    year_col = "Posting Year" if is_posting else "Vendor Doc Year"
    month_col = "Posting Month" if is_posting else "Vendor Doc Month"
    week_col = "Posting Week" if is_posting else "Vendor Doc Week"
    day_col = "Posting Day" if is_posting else "Vendor Doc Day"
    date_col = POSTING_DATE_COL if is_posting else VENDOR_DOC_DATE_COL

    # Create period grouping key and display label (FL5, FL6)
    if granularity == "Yearly":
        group_cols = [year_col]
        df_group = df.copy()
        df_group["period_label"] = df_group[year_col].astype(str)
        df_group["period_sort"] = df_group[year_col]

    elif granularity == "Monthly":
        group_cols = [year_col, month_col]
        df_group = df.copy()
        # "Sep-2026"
        df_group["period_label"] = df_group.apply(
            lambda r: f"{MONTH_ABBRS[int(r[month_col]) - 1]}-{r[year_col]}" if 1 <= int(r[month_col]) <= 12 else str(r[year_col]),
            axis=1,
        )
        df_group["period_sort"] = df_group[year_col] * 100 + df_group[month_col]

    elif granularity == "Weekly":
        group_cols = [year_col, week_col]
        df_group = df.copy()
        # "2026-W39"
        df_group["period_label"] = df_group.apply(
            lambda r: f"{r[year_col]}-W{int(r[week_col])}", axis=1
        )
        df_group["period_sort"] = df_group[year_col] * 100 + df_group[week_col]

    else:  # Daily
        group_cols = [year_col, month_col, week_col, day_col, date_col]
        df_group = df.copy()
        # "22-Sep-26" (FL6: actual calendar date)
        dt_series = pd.to_datetime(df_group[date_col], errors="coerce")
        df_group["period_label"] = dt_series.dt.strftime("%d-%b-%y").fillna("Unknown")
        df_group["period_sort"] = dt_series

    if measure == "Spend":
        # Group by period label, sum spend
        grouped = df_group.groupby(["period_sort", "period_label"])[SPEND_COL].sum().reset_index()
        grouped = grouped.sort_values(by="period_sort")

        return {
            "labels": grouped["period_label"].tolist(),
            "datasets": [
                {
                    "label": "Spend (INR)",
                    "data": [round(float(v), 2) for v in grouped[SPEND_COL].tolist()],
                    "backgroundColor": "#1e3a8a",
                    "borderColor": "#172554",
                    "borderWidth": 1,
                }
            ],
        }
    else:
        # Quantity Mode: side-by-side bar per UoM (CH2)
        # Distinct UoMs in this selection
        uoms = df_group[UOM_COL].unique().tolist()
        # Order periods
        periods_df = df_group[["period_sort", "period_label"]].drop_duplicates().sort_values("period_sort")
        labels = periods_df["period_label"].tolist()

        color_palette = [
            "#0f766e", "#2563eb", "#d97706", "#7c3aed",
            "#dc2626", "#059669", "#4f46e5", "#ea580c",
        ]

        datasets = []
        for idx, uom in enumerate(uoms):
            uom_df = df_group[df_group[UOM_COL] == uom]
            uom_grouped = uom_df.groupby("period_label")[QTY_COL].sum().to_dict()
            data = [round(float(uom_grouped.get(lbl, 0.0)), 2) for lbl in labels]
            color = color_palette[idx % len(color_palette)]

            datasets.append({
                "label": f"Qty ({uom})",
                "data": data,
                "backgroundColor": color,
                "borderColor": color,
                "borderWidth": 1,
            })

        return {"labels": labels, "datasets": datasets}


def _compute_breakdown_charts(df: pd.DataFrame, measure: str) -> dict[str, Any]:
    """Compute all 10 horizontal breakdown charts according to Rules CH3–CH10."""
    result = {}

    # 1. Import vs Domestic (Domestic = Doc Currency INR, Import = other)
    df_im_dom = df.copy()
    df_im_dom["ImportDomestic"] = np.where(df_im_dom[CURRENCY_COL] == "INR", "Domestic", "Import")
    result["import_domestic"] = _format_horizontal_chart(df_im_dom, "ImportDomestic", measure)

    # 2. Receiving State
    result["receiving_state"] = _format_horizontal_chart(df, RECEIVING_STATE_COL, measure)

    # 3. Item Group
    result["item_group"] = _format_horizontal_chart(df, ITEM_GROUP_COL, measure)

    # 4. Sub Group 1
    result["sub_group1"] = _format_horizontal_chart(df, SUB_GROUP1_COL, measure)

    # 5. Sub Group 2
    result["sub_group2"] = _format_horizontal_chart(df, SUB_GROUP2_COL, measure)

    # 6. Brand
    result["brand"] = _format_horizontal_chart(df, BRAND_COL, measure)

    # 7. Buyer [Row Buyer]
    result["buyer"] = _format_horizontal_chart(df, BUYER_COL, measure)

    # 8. Credit vs Advance [Purchase Type]
    result["purchase_type"] = _format_horizontal_chart(df, PURCHASE_TYPE_COL, measure)

    # 9. Top 50 Vendors + Others (ranked by Spend always, CH8)
    result["top_vendors"] = _compute_top_50_vendors_chart(df, measure)

    # 10. Vendor Group [Group]
    result["vendor_group"] = _format_horizontal_chart(df, VENDOR_GROUP_COL, measure)

    return result


def _format_horizontal_chart(
    df: pd.DataFrame,
    cat_col: str,
    measure: str,
) -> dict[str, Any]:
    """Format single horizontal breakdown bar chart sorted largest to smallest (CH5, CH6, CH7)."""
    if cat_col not in df.columns or df.empty:
        return {"labels": [], "datasets": []}

    if measure == "Spend":
        grouped = df.groupby(cat_col)[SPEND_COL].sum().sort_values(ascending=False)
        labels = [str(k) for k in grouped.index.tolist()]
        values = [round(float(v), 2) for v in grouped.values.tolist()]

        return {
            "labels": labels,
            "datasets": [
                {
                    "label": "Spend (INR)",
                    "data": values,
                    "backgroundColor": "#0f766e",
                    "borderColor": "#115e59",
                    "borderWidth": 1,
                }
            ],
        }
    else:
        # Quantity Mode: grouped by category, one bar per UoM (CH9)
        # Sort categories by total quantity descending
        cat_totals = df.groupby(cat_col)[QTY_COL].sum().sort_values(ascending=False)
        labels = [str(k) for k in cat_totals.index.tolist()]
        uoms = df[UOM_COL].unique().tolist()

        color_palette = [
            "#0f766e", "#2563eb", "#d97706", "#7c3aed",
            "#dc2626", "#059669", "#4f46e5", "#ea580c",
        ]

        datasets = []
        for idx, uom in enumerate(uoms):
            uom_df = df[df[UOM_COL] == uom]
            cat_uom = uom_df.groupby(cat_col)[QTY_COL].sum().to_dict()
            data = [round(float(cat_uom.get(cat, 0.0)), 2) for cat in labels]
            color = color_palette[idx % len(color_palette)]

            datasets.append({
                "label": f"Qty ({uom})",
                "data": data,
                "backgroundColor": color,
                "borderColor": color,
                "borderWidth": 1,
            })

        return {"labels": labels, "datasets": datasets}


def _compute_top_50_vendors_chart(df: pd.DataFrame, measure: str) -> dict[str, Any]:
    """Compute Top 50 Vendors ranked by Spend, with Others (CH8)."""
    if VENDOR_COL not in df.columns or df.empty:
        return {"labels": [], "datasets": []}

    # Vendors are ALWAYS ranked by Spend (CH8)
    vendor_spend = df.groupby(VENDOR_COL)[SPEND_COL].sum().sort_values(ascending=False)
    all_vendors = vendor_spend.index.tolist()

    top_50_vendors = all_vendors[:50]
    others_vendors = all_vendors[50:]

    if measure == "Spend":
        labels = [str(v) for v in top_50_vendors]
        data = [round(float(vendor_spend[v]), 2) for v in top_50_vendors]

        if others_vendors:
            others_spend = round(float(vendor_spend[others_vendors].sum()), 2)
            labels.append(f"Others ({len(others_vendors)} vendors)")
            data.append(others_spend)

        return {
            "labels": labels,
            "datasets": [
                {
                    "label": "Spend (INR)",
                    "data": data,
                    "backgroundColor": "#1e3a8a",
                    "borderColor": "#172554",
                    "borderWidth": 1,
                }
            ],
        }
    else:
        # Quantity Mode: still ranked by Spend (CH8)
        uoms = df[UOM_COL].unique().tolist()
        labels = [str(v) for v in top_50_vendors]
        if others_vendors:
            labels.append(f"Others ({len(others_vendors)} vendors)")

        color_palette = [
            "#0f766e", "#2563eb", "#d97706", "#7c3aed",
            "#dc2626", "#059669", "#4f46e5", "#ea580c",
        ]

        datasets = []
        for idx, uom in enumerate(uoms):
            uom_df = df[df[UOM_COL] == uom]
            vendor_qty = uom_df.groupby(VENDOR_COL)[QTY_COL].sum().to_dict()

            data = [round(float(vendor_qty.get(v, 0.0)), 2) for v in top_50_vendors]
            if others_vendors:
                others_qty = sum(float(vendor_qty.get(v, 0.0)) for v in others_vendors)
                data.append(round(others_qty, 2))

            color = color_palette[idx % len(color_palette)]
            datasets.append({
                "label": f"Qty ({uom})",
                "data": data,
                "backgroundColor": color,
                "borderColor": color,
                "borderWidth": 1,
            })

        return {"labels": labels, "datasets": datasets}


def _compute_filter_options(
    df: pd.DataFrame,
    date_basis: str,
    filters: dict[str, Any],
) -> dict[str, Any]:
    """Compute faceted dropdown values and counts for all 8 filter sections (FT5, FT6, FT7)."""
    options = {}

    is_posting = (date_basis == "Posting Date")
    year_col = "Posting Year" if is_posting else "Vendor Doc Year"
    month_col = "Posting Month" if is_posting else "Vendor Doc Month"
    week_col = "Posting Week" if is_posting else "Vendor Doc Week"
    day_col = "Posting Day" if is_posting else "Vendor Doc Day"

    # Helper to calculate options with counts
    def _extract_options(exclude_key: str, col: str, is_numeric_period: bool = False):
        mask = _get_active_filters_mask(df, date_basis, filters, exclude_key=exclude_key)
        subset = df[mask]
        counts = subset[col].value_counts().to_dict() if col in subset.columns else {}

        selected = filters.get(exclude_key) or []
        if not isinstance(selected, list):
            selected = [selected]
        selected_str = [str(s) for s in selected]

        items = []
        # Add all items with current count
        for val, cnt in counts.items():
            val_str = str(val)
            items.append({
                "value": val_str,
                "count": int(cnt),
                "is_stale": False,
            })

        # Add stale selected values with count 0 (FT7)
        existing_vals = {item["value"] for item in items}
        for sel in selected_str:
            if sel not in existing_vals:
                items.append({
                    "value": sel,
                    "count": 0,
                    "is_stale": True,
                })

        # Sort: numeric if period, otherwise alphabetical with (Blank) at bottom
        if is_numeric_period:
            items.sort(key=lambda x: int(x["value"]) if str(x["value"]).isdigit() else -1)
        else:
            items.sort(key=lambda x: (x["value"] == "(Blank)", x["value"]))

        return items

    # Section 1: Period
    options["year"] = _extract_options("year", year_col, is_numeric_period=True)
    options["month"] = _extract_options("month", month_col, is_numeric_period=True)
    options["week"] = _extract_options("week", week_col, is_numeric_period=True)
    options["day"] = _extract_options("day", day_col, is_numeric_period=True)

    # Section 2: Document & Terms
    options["document"] = _extract_options("document", DOC_COL)
    options["documentType"] = _extract_options("documentType", "Document Type")
    options["purchaseType"] = _extract_options("purchaseType", PURCHASE_TYPE_COL)
    options["docCurrency"] = _extract_options("docCurrency", CURRENCY_COL)

    # Section 3: Vendor
    options["bpName"] = _extract_options("bpName", VENDOR_COL)
    options["vendorGroup"] = _extract_options("vendorGroup", VENDOR_GROUP_COL)
    options["industry"] = _extract_options("industry", "Industry")
    options["vendorCity"] = _extract_options("vendorCity", "Vendor City")
    options["vendorState"] = _extract_options("vendorState", "Vendor State")
    options["vendorCountry"] = _extract_options("vendorCountry", "Vendor Country")

    # Section 4: Buyer
    options["rowBuyer"] = _extract_options("rowBuyer", BUYER_COL)

    # Section 5: Receiving Location
    options["receivingState"] = _extract_options("receivingState", RECEIVING_STATE_COL)
    options["receivingCity"] = _extract_options("receivingCity", RECEIVING_CITY_COL)

    # Section 6: Item Groups
    options["itemGroup"] = _extract_options("itemGroup", ITEM_GROUP_COL)
    options["subGroup1"] = _extract_options("subGroup1", SUB_GROUP1_COL)
    options["subGroup2"] = _extract_options("subGroup2", SUB_GROUP2_COL)

    # Section 7: Item General
    options["itemCode"] = _extract_options("itemCode", "Item Code")
    options["brand"] = _extract_options("brand", BRAND_COL)
    options["moc"] = _extract_options("moc", "MOC")
    options["madeToOrder"] = _extract_options("madeToOrder", "Made To Order")
    options["uom"] = _extract_options("uom", UOM_COL)

    # Section 8: Item Attributes
    options["itemAttributes"] = {}
    for attr in ITEM_ATTRIBUTE_COLUMNS:
        options["itemAttributes"][attr] = _extract_options(f"attr_{attr}", attr)

    return options


def _compute_detail_table(
    df: pd.DataFrame,
    page: int,
    page_size: int,
    sort_column: str,
    sort_direction: str,
) -> dict[str, Any]:
    """
    Format and paginate the 13 columns of the Detail Table (TB1–TB5).
    Sorting covers the entire filtered dataset across all pages (TB4b).
    """
    total_rows = len(df)
    if total_rows == 0:
        return {"rows": [], "total_rows": 0, "page": 1, "total_pages": 0}

    # Map requested sort column to DataFrame column
    col_map = {
        "DocNum": "DocNum",
        "Document": DOC_COL,
        "Document Type": "Document Type",
        "Posting Date": POSTING_DATE_COL,
        "Vendors Doc Date": VENDOR_DOC_DATE_COL,
        "BP Name": VENDOR_COL,
        "Item Code": "Item Code",
        "Quantity": QTY_COL,
        "UoM": UOM_COL,
        "Row Total (After Doc Disc)": SPEND_COL,
        "Vendors Doc No.": "Vendors Doc No.",
        "Row Buyer": BUYER_COL,
    }

    df_sorted = df
    sort_target = col_map.get(sort_column, POSTING_DATE_COL)
    ascending = (sort_direction.lower() == "asc")

    if sort_target in df.columns:
        df_sorted = df.sort_values(by=sort_target, ascending=ascending)

    # Pagination slice
    page = max(1, page)
    start_idx = (page - 1) * page_size
    end_idx = start_idx + page_size
    page_slice = df_sorted.iloc[start_idx:end_idx]

    # Format rows according to TB3
    rows = []
    for rank, (_, row) in enumerate(page_slice.iterrows(), start=start_idx + 1):
        rows.append({
            "#": rank,
            "DocNum": int(row.get("DocNum", 0)) if pd.notnull(row.get("DocNum")) else "-",
            "Document": str(row.get(DOC_COL, "")),
            "Document Type": str(row.get("Document Type", "")),
            "Posting Date": str(row.get("Posting_Date_Formatted", "")),
            "Vendors Doc Date": str(row.get("Vendor_Doc_Date_Formatted", "")),
            "BP Name": str(row.get(VENDOR_COL, "")),
            "Item Code": str(row.get("Item Code", "")),
            "Quantity": f"{float(row.get(QTY_COL, 0.0)):,.2f}" if pd.notnull(row.get(QTY_COL)) else "-",
            "UoM": str(row.get(UOM_COL, "")),
            "Row Total (After Doc Disc)": f"₹{float(row.get(SPEND_COL, 0.0)):,.2f}" if pd.notnull(row.get(SPEND_COL)) else "-",
            "Vendors Doc No.": str(row.get("Vendors Doc No.", "")),
            "Row Buyer": str(row.get(BUYER_COL, "")),
        })

    total_pages = (total_rows + page_size - 1) // page_size

    return {
        "rows": rows,
        "total_rows": total_rows,
        "page": page,
        "total_pages": total_pages,
        "start_row": start_idx + 1 if total_rows > 0 else 0,
        "end_row": min(end_idx, total_rows),
    }
