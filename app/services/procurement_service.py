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
import calendar
from datetime import datetime, timezone, date, timedelta
import gc
import logging
import time
from typing import Any

import numpy as np
import pandas as pd

from app.api.client import api_request, ApiError
from app.auth.request_context import get_current_database_target
from app.config import settings

logger = logging.getLogger(__name__)

# In-memory query calculation caches (cleared on dataset refresh)
_facet_cache: dict[tuple, dict[str, Any]] = {}
_breakdown_cache: dict[tuple, dict[str, Any]] = {}
_table_cache: dict[tuple, tuple[pd.DataFrame, int]] = {}
_mask_cache: dict[tuple, pd.Series] = {}


def clear_query_caches() -> None:
    """Clear all in-memory calculation caches on dataset reload/refresh."""
    _facet_cache.clear()
    _breakdown_cache.clear()
    _table_cache.clear()
    _mask_cache.clear()


def _hash_filters(filters: dict[str, Any] | None) -> tuple:
    """Produce a deterministic, hashable representation of the active filters."""
    if not filters:
        return ()
    items = []
    for k in sorted(filters.keys()):
        v = filters[k]
        if not v:
            continue
        if k == "itemAttributes" and isinstance(v, dict):
            sub_items = tuple(
                (sub_k, tuple(sorted(str(x) for x in sub_v)))
                for sub_k, sub_v in sorted(v.items())
                if sub_v
            )
            if sub_items:
                items.append((k, sub_items))
        elif isinstance(v, list):
            valid_vals = tuple(sorted(str(x) for x in v if x is not None and str(x) != ""))
            if valid_vals:
                items.append((k, valid_vals))
        elif v is not None and str(v) != "":
            items.append((k, str(v)))
    return tuple(items)

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

MONTH_NAME_TO_NUM = {
    "jan": 1, "january": 1, "1": 1, "01": 1,
    "feb": 2, "february": 2, "2": 2, "02": 2,
    "mar": 3, "march": 3, "3": 3, "03": 3,
    "apr": 4, "april": 4, "4": 4, "04": 4,
    "may": 5, "5": 5, "05": 5,
    "jun": 6, "june": 6, "6": 6, "06": 6,
    "jul": 7, "july": 7, "7": 7, "07": 7,
    "aug": 8, "august": 8, "8": 8, "08": 8,
    "sep": 9, "september": 9, "9": 9, "09": 9,
    "oct": 10, "october": 10, "10": 10,
    "nov": 11, "november": 11, "11": 11,
    "dec": 12, "december": 12, "12": 12,
}


def get_month_weeks(year: int, month: int) -> list[dict[str, Any]]:
    """
    Return Monday-Sunday calendar weeks restricted to the selected month (Section 2 Level 3).
    Each week has start_date, end_date, and readable label e.g. 'Week 1 (01–03 Mar)'.
    """
    _, num_days = calendar.monthrange(year, month)
    weeks = []
    d = 1
    w_idx = 1
    month_abbr = MONTH_ABBRS[month - 1]
    while d <= num_days:
        start_d = d
        dt = date(year, month, d)
        days_until_sunday = 6 - dt.weekday()
        end_d = min(num_days, d + days_until_sunday)
        start_str = f"{year:04d}-{month:02d}-{start_d:02d}"
        end_str = f"{year:04d}-{month:02d}-{end_d:02d}"
        if start_d == end_d:
            lbl = f"Week {w_idx} ({start_d:02d} {month_abbr})"
        else:
            lbl = f"Week {w_idx} ({start_d:02d}–{end_d:02d} {month_abbr})"
        weeks.append({
            "week_num": w_idx,
            "label": lbl,
            "start_date": start_str,
            "end_date": end_str,
            "start_day": start_d,
            "end_day": end_d,
            "year": year,
            "month": month,
            "month_name": calendar.month_name[month],
        })
        d = end_d + 1
        w_idx += 1
    return weeks


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
        self._is_loading: bool = False
        self._load_error: str | None = None
        self._load_progress: str = "Ready"
        self._loaded_so_far: int = 0
        self._load_task: asyncio.Task | None = None

    @classmethod
    def get_instance(cls) -> ProcurementDataStore:
        if cls._instance is None:
            cls._instance = ProcurementDataStore()
        return cls._instance

    @property
    def is_loaded(self) -> bool:
        return self._df is not None and not self._df.empty

    @property
    def is_loading(self) -> bool:
        return self._is_loading

    @property
    def load_error(self) -> str | None:
        return self._load_error

    @property
    def load_progress(self) -> str:
        return self._load_progress

    @property
    def loaded_so_far(self) -> int:
        return self._loaded_so_far

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

    def start_background_load(self, force_refresh: bool = False) -> None:
        """Initiate background data load without blocking HTTP response."""
        if self._df is not None and not self._df.empty and not force_refresh:
            return
        if self._is_loading or (self._load_task and not self._load_task.done()):
            return
        self._is_loading = True
        self._load_error = None
        self._load_progress = "Connecting to database..."
        self._loaded_so_far = 0
        if force_refresh:
            clear_query_caches()
        try:
            loop = asyncio.get_running_loop()
            self._load_task = loop.create_task(self._do_background_load(force_refresh=force_refresh))
        except RuntimeError:
            try:
                self._load_task = asyncio.create_task(self._do_background_load(force_refresh=force_refresh))
            except RuntimeError:
                pass

    async def _do_background_load(self, force_refresh: bool = False) -> None:
        async with self._lock:
            if self._df is not None and not self._df.empty and not force_refresh:
                self._is_loading = False
                return
            try:
                await self._load_data()
                self._load_progress = "Ready"
            except Exception as exc:
                logger.exception("Failed to load procurement dataset: %s", exc)
                self._load_error = str(exc)
                self._load_progress = f"Error: {exc}"
            finally:
                self._is_loading = False

    async def get_dataframe(self, force_refresh: bool = False) -> pd.DataFrame:
        """Return the loaded DataFrame, loading or refreshing if required."""
        if self._df is not None and not force_refresh:
            return self._df

        async with self._lock:
            if self._df is not None and not force_refresh:
                return self._df
            self._is_loading = True
            self._load_error = None
            try:
                await self._load_data()
            except Exception as exc:
                self._load_error = str(exc)
                raise
            finally:
                self._is_loading = False
            return self._df

    async def _load_data(self) -> None:
        """Fetch the full view in memory-efficient chunks with bounded concurrency."""
        target_db = get_current_database_target() or settings.api_database or "OperationsDB"
        logger.info("Initiating full dataset load from VD_Procurement_Dashboard (%s)", target_db)
        self._load_progress = "Fetching initial batch..."

        batch_size = 10000
        stable_order = "DocNum,Document,Quantity,UoM"
        first_resp = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns="*",
            order_by=stable_order,
            page=1,
            limit=batch_size,
            database=target_db,
        )

        total_rows = int(first_resp.get("totalRows", 0) or 0)
        total_pages = int(first_resp.get("totalPages", 1) or 1)
        page_frames: list[pd.DataFrame] = []

        first_rows = first_resp.get("data") or []
        if first_rows:
            chunk1 = pd.DataFrame(first_rows)
            if SPEND_COL in chunk1.columns:
                chunk1[SPEND_COL] = pd.to_numeric(chunk1[SPEND_COL], errors="coerce").fillna(0.0).astype("float64")
            if QTY_COL in chunk1.columns:
                chunk1[QTY_COL] = pd.to_numeric(chunk1[QTY_COL], errors="coerce").fillna(0.0).astype("float64")
            page_frames.append(chunk1)
            self._loaded_so_far = len(chunk1)
            self._load_progress = f"Loaded {self._loaded_so_far:,} of {total_rows:,} records..."
        del first_rows, first_resp
        gc.collect()

        if total_pages > 1:
            sem = asyncio.Semaphore(2)

            async def _fetch_page(page_num: int) -> pd.DataFrame:
                async with sem:
                    resp = await api_request(
                        table="VD_Procurement_Dashboard",
                        action="select",
                        columns="*",
                        order_by=stable_order,
                        page=page_num,
                        limit=batch_size,
                        database=target_db,
                    )
                    rows = resp.get("data") or []
                    if rows:
                        df_chunk = pd.DataFrame(rows)
                        if SPEND_COL in df_chunk.columns:
                            df_chunk[SPEND_COL] = pd.to_numeric(df_chunk[SPEND_COL], errors="coerce").fillna(0.0).astype("float64")
                        if QTY_COL in df_chunk.columns:
                            df_chunk[QTY_COL] = pd.to_numeric(df_chunk[QTY_COL], errors="coerce").fillna(0.0).astype("float64")
                    else:
                        df_chunk = pd.DataFrame()
                    del rows, resp
                    gc.collect()
                    self._loaded_so_far += len(df_chunk)
                    self._load_progress = f"Loaded {min(self._loaded_so_far, total_rows):,} of {total_rows:,} records (batch {page_num}/{total_pages})..."
                    logger.info("Loaded batch %d/%d (%d rows)", page_num, total_pages, len(df_chunk))
                    return df_chunk

            tasks = [_fetch_page(p) for p in range(2, total_pages + 1)]
            remaining_frames = await asyncio.gather(*tasks)
            page_frames.extend([f for f in remaining_frames if not f.empty])
            del remaining_frames
            gc.collect()

        if not page_frames:
            if total_rows > 0:
                raise ApiError(
                    f"Failed to load records: expected {total_rows}, received 0",
                    table="VD_Procurement_Dashboard",
                )
            df = pd.DataFrame()
        else:
            self._load_progress = "Optimizing dataset in memory..."
            df = pd.concat(page_frames, ignore_index=True, copy=False)
            del page_frames
            gc.collect()

        actual_count = len(df)
        logger.info(
            "Retrieved %d records (reported total: %d); DataFrame constructed",
            actual_count, total_rows
        )
        if total_rows and actual_count < total_rows:
            logger.warning(
                "Procurement dataset is incomplete: expected %d rows, received %d",
                total_rows, actual_count
            )

        # Numeric conversions (float64 to preserve exact monetary precision)
        for numeric_col in (SPEND_COL, QTY_COL):
            if numeric_col in df.columns:
                df[numeric_col] = pd.to_numeric(df[numeric_col], errors="coerce").fillna(0.0).astype("float64")

        # Date conversions & formatted display columns
        for date_col, disp_col in (
            (POSTING_DATE_COL, "Posting_Date_Formatted"),
            (VENDOR_DOC_DATE_COL, "Vendor_Doc_Date_Formatted"),
        ):
            if date_col in df.columns:
                dt_series = pd.to_datetime(df[date_col], errors="coerce")
                df[disp_col] = dt_series.dt.strftime("%d-%b-%Y").fillna("")
                df[f"{date_col}_ISO"] = dt_series.dt.strftime("%Y-%m-%d").fillna("")

        # Handle Period integers
        for p_col in (
            "Posting Year", "Posting Month", "Posting Week", "Posting Day",
            "Vendor Doc Year", "Vendor Doc Month", "Vendor Doc Week", "Vendor Doc Day",
        ):
            if p_col in df.columns:
                df[p_col] = pd.to_numeric(df[p_col], errors="coerce").fillna(0).astype("int32")

        # Normalize categorical text and use pandas category dtype for low-cardinality
        # columns; this substantially reduces RAM for repeated vendor/location/status values.
        categorical_cols = [
            DOC_COL, "Document Type", PURCHASE_TYPE_COL, CURRENCY_COL,
            VENDOR_COL, VENDOR_GROUP_COL, "Industry", "Vendor City", "Vendor State", "Vendor Country",
            BUYER_COL, RECEIVING_STATE_COL, RECEIVING_CITY_COL,
            ITEM_GROUP_COL, SUB_GROUP1_COL, SUB_GROUP2_COL,
            "Item Code", "Item Name", BRAND_COL, "MOC", "Made To Order", UOM_COL,
        ] + ITEM_ATTRIBUTE_COLUMNS

        for col in categorical_cols:
            if col in df.columns:
                series = df[col].fillna("(Blank)").astype(str).replace(
                    {"None": "(Blank)", "nan": "(Blank)", "": "(Blank)", "Null": "(Blank)", "null": "(Blank)"}
                )
                if len(series) and series.nunique(dropna=False) < len(series) * 0.70:
                    df[col] = series.astype("category")
                else:
                    df[col] = series

        gc.collect()

        logger.info(
            "Procurement DataFrame normalized: rows=%d, columns=%d, memory=%.1f MB",
            len(df), len(df.columns),
            float(df.memory_usage(index=True, deep=True).sum()) / (1024 * 1024)
        )

        logger.info("Starting procurement date/grouping precomputation")
        _precompute_dataframe_columns(df)
        logger.info("Procurement date/grouping precomputation complete")

        clear_query_caches()
        self._df = df
        self._total_records = actual_count
        self._data_as_of = datetime.now(timezone.utc)
        self._database = target_db
        gc.collect()
        logger.info("Procurement dataset ready: %d records from %s", actual_count, target_db)


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


def _precompute_dataframe_columns(df: pd.DataFrame) -> None:
    """Pre-compute vectorized display and period grouping columns to eliminate runtime overhead."""
    if df.empty:
        return

    # Pre-compute Import vs Domestic (eliminates df.copy() in CH3)
    if "ImportDomestic" not in df.columns:
        if CURRENCY_COL in df.columns:
            df["ImportDomestic"] = np.where(df[CURRENCY_COL] == "INR", "Domestic", "Import")
        else:
            df["ImportDomestic"] = "Domestic"

    month_map = {i + 1: MONTH_ABBRS[i] for i in range(12)}

    # 1. Posting Date Period Columns
    if "Posting Month" in df.columns and "Posting Year" in df.columns:
        p_m = df["Posting Month"]
        p_y = df["Posting Year"].astype(str)
        df["Posting_Month_Label"] = p_m.map(month_map).fillna("") + "-" + p_y
        df["Posting_Month_Sort"] = df["Posting Year"] * 100 + df["Posting Month"]
        df["Posting_Year_Label"] = p_y
        df["Posting_Year_Sort"] = df["Posting Year"]

    if "Posting Week" in df.columns and "Posting Year" in df.columns:
        df["Posting_Week_Label"] = df["Posting Year"].astype(str) + "-W" + df["Posting Week"].astype(str)
        df["Posting_Week_Sort"] = df["Posting Year"] * 100 + df["Posting Week"]

    if POSTING_DATE_COL in df.columns:
        dt_p = pd.to_datetime(df[POSTING_DATE_COL], errors="coerce")
        df["Posting_Daily_Label"] = dt_p.dt.strftime("%d-%b-%y").fillna("Unknown")
        df["Posting_Daily_Sort"] = dt_p

    # 2. Vendor Doc Date Period Columns
    if "Vendor Doc Month" in df.columns and "Vendor Doc Year" in df.columns:
        v_m = df["Vendor Doc Month"]
        v_y = df["Vendor Doc Year"].astype(str)
        df["Vendor_Doc_Month_Label"] = v_m.map(month_map).fillna("") + "-" + v_y
        df["Vendor_Doc_Month_Sort"] = df["Vendor Doc Year"] * 100 + df["Vendor Doc Month"]
        df["Vendor_Doc_Year_Label"] = v_y
        df["Vendor_Doc_Year_Sort"] = df["Vendor Doc Year"]

    if "Vendor Doc Week" in df.columns and "Vendor Doc Year" in df.columns:
        df["Vendor_Doc_Week_Label"] = df["Vendor Doc Year"].astype(str) + "-W" + df["Vendor Doc Week"].astype(str)
        df["Vendor_Doc_Week_Sort"] = df["Vendor Doc Year"] * 100 + df["Vendor Doc Week"]

    if VENDOR_DOC_DATE_COL in df.columns:
        dt_v = pd.to_datetime(df[VENDOR_DOC_DATE_COL], errors="coerce")
        df["Vendor_Doc_Daily_Label"] = dt_v.dt.strftime("%d-%b-%y").fillna("Unknown")
        df["Vendor_Doc_Daily_Sort"] = dt_v


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
    if not filters:
        return pd.Series(True, index=df.index)

    mask = None

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
            c = (df[date_col_iso] >= from_date)
            mask = c if mask is None else (mask & c)
        if to_date and date_col_iso in df.columns:
            c = (df[date_col_iso] <= to_date)
            mask = c if mask is None else (mask & c)

    # Year
    if exclude_key != "year" and filters.get("year"):
        selected_years = [int(y) for y in filters["year"] if str(y).isdigit()]
        if selected_years and year_col in df.columns:
            c = df[year_col].isin(selected_years)
            mask = c if mask is None else (mask & c)

    # Month
    if exclude_key != "month" and filters.get("month"):
        month_vals = filters["month"]
        if not isinstance(month_vals, list):
            month_vals = [month_vals]
        selected_months = []
        for m in month_vals:
            m_str = str(m).strip().lower()
            if m_str.isdigit():
                selected_months.append(int(m_str))
            elif m_str in MONTH_NAME_TO_NUM:
                selected_months.append(MONTH_NAME_TO_NUM[m_str])
        if selected_months and month_col in df.columns:
            c = df[month_col].isin(selected_months)
            mask = c if mask is None else (mask & c)

    # Week
    if exclude_key != "week" and filters.get("week"):
        selected_weeks = [int(w) for w in filters["week"] if str(w).isdigit()]
        if selected_weeks and week_col in df.columns:
            c = df[week_col].isin(selected_weeks)
            mask = c if mask is None else (mask & c)

    # Day
    if exclude_key != "day" and filters.get("day"):
        selected_days = [int(d) for d in filters["day"] if str(d).isdigit()]
        if selected_days and day_col in df.columns:
            c = df[day_col].isin(selected_days)
            mask = c if mask is None else (mask & c)

    # Standard Categorical Filters mapping
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
            if isinstance(vals, list) and vals and col in df.columns:
                c = _apply_filter_condition(df, col, vals)
                mask = c if mask is None else (mask & c)

    # Item Attributes (FT1-8)
    item_attrs = filters.get("itemAttributes") or {}
    for attr_col in ITEM_ATTRIBUTE_COLUMNS:
        attr_key = f"attr_{attr_col}"
        if exclude_key != attr_key and item_attrs.get(attr_col):
            vals = item_attrs[attr_col]
            if isinstance(vals, list) and vals and attr_col in df.columns:
                c = _apply_filter_condition(df, attr_col, vals)
                mask = c if mask is None else (mask & c)

    if mask is None:
        return pd.Series(True, index=df.index)
    return mask


def _get_period_cols(df: pd.DataFrame, granularity: str, date_basis: str) -> tuple[str, str]:
    """Return (label_column, sort_column) for the given granularity and date basis."""
    is_posting = (date_basis == "Posting Date")
    prefix = "Posting" if is_posting else "Vendor_Doc"
    year_col = "Posting Year" if is_posting else "Vendor Doc Year"
    month_col = "Posting Month" if is_posting else "Vendor Doc Month"
    week_col = "Posting Week" if is_posting else "Vendor Doc Week"
    date_col = POSTING_DATE_COL if is_posting else VENDOR_DOC_DATE_COL

    if granularity == "Yearly":
        label_col = f"{prefix}_Year_Label"
        sort_col = f"{prefix}_Year_Sort"
        if label_col not in df.columns and year_col in df.columns:
            df[label_col] = df[year_col].astype(str)
            df[sort_col] = df[year_col]
        return label_col, sort_col

    elif granularity == "Monthly":
        label_col = f"{prefix}_Month_Label"
        sort_col = f"{prefix}_Month_Sort"
        if label_col not in df.columns and month_col in df.columns and year_col in df.columns:
            month_map = {i + 1: MONTH_ABBRS[i] for i in range(12)}
            df[label_col] = df[month_col].map(month_map).fillna("") + "-" + df[year_col].astype(str)
            df[sort_col] = df[year_col] * 100 + df[month_col]
        return label_col, sort_col

    elif granularity == "Weekly":
        label_col = f"{prefix}_Week_Label"
        sort_col = f"{prefix}_Week_Sort"
        if label_col not in df.columns and week_col in df.columns and year_col in df.columns:
            df[label_col] = df[year_col].astype(str) + "-W" + df[week_col].astype(str)
            df[sort_col] = df[year_col] * 100 + df[week_col]
        return label_col, sort_col

    else:  # Daily
        label_col = f"{prefix}_Daily_Label"
        sort_col = f"{prefix}_Daily_Sort"
        if label_col not in df.columns and date_col in df.columns:
            dt = pd.to_datetime(df[date_col], errors="coerce")
            df[label_col] = dt.dt.strftime("%d-%b-%y").fillna("Unknown")
            df[sort_col] = dt
        return label_col, sort_col


def _compute_main_chart(
    df: pd.DataFrame,
    granularity: str,
    measure: str,
    date_basis: str,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Generate main vertical bar chart grouping according to Rules FL5, FL6, CH1, CH2,
    with cascading drill-down support: Year -> Month -> Week -> Date.
    """
    if df.empty:
        return {"labels": [], "datasets": [], "meta": []}

    is_posting = (date_basis == "Posting Date")
    year_col = "Posting Year" if is_posting else "Vendor Doc Year"
    month_col = "Posting Month" if is_posting else "Vendor Doc Month"
    date_col_iso = f"{POSTING_DATE_COL}_ISO" if is_posting else f"{VENDOR_DOC_DATE_COL}_ISO"

    filters = filters or {}
    year_filters = filters.get("year") or []
    if not isinstance(year_filters, list):
        year_filters = [year_filters]
    valid_year_filters = [int(y) for y in year_filters if str(y).isdigit()]

    month_filters = filters.get("month") or []
    if not isinstance(month_filters, list):
        month_filters = [month_filters]
    valid_month_filters = []
    for m in month_filters:
        m_str = str(m).strip().lower()
        if m_str.isdigit():
            valid_month_filters.append(int(m_str))
        elif m_str in MONTH_NAME_TO_NUM:
            valid_month_filters.append(MONTH_NAME_TO_NUM[m_str])

    from_date = filters.get("fromDate")
    to_date = filters.get("toDate")

    # 1. Drill-down LEVEL 2: Monthly View (when single year is selected/drilled)
    if granularity == "Monthly":
        single_year = None
        if len(valid_year_filters) == 1:
            single_year = valid_year_filters[0]
        elif year_col in df.columns and df[year_col].nunique() == 1:
            single_year = int(df[year_col].iloc[0])

        if single_year is not None:
            # Display all 12 months for this year (Rule from Section 2 & 8)
            labels = [f"{MONTH_ABBRS[m-1]}-{single_year}" for m in range(1, 13)]
            meta = [
                {
                    "month": m,
                    "month_name": calendar.month_name[m],
                    "year": single_year,
                    "label": f"{MONTH_ABBRS[m-1]}-{single_year}",
                }
                for m in range(1, 13)
            ]

            if measure == "Spend":
                m_spend_map = df.groupby(month_col, observed=False)[SPEND_COL].sum().to_dict()
                data = [round(float(m_spend_map.get(m, 0.0)), 2) for m in range(1, 13)]
                return {
                    "labels": labels,
                    "datasets": [{
                        "label": "Spend (INR)",
                        "data": data,
                        "backgroundColor": "#1e3a8a",
                        "borderColor": "#172554",
                        "borderWidth": 1,
                    }],
                    "meta": meta,
                }
            else:
                uoms = [u for u in df[UOM_COL].unique().tolist() if u is not None and str(u) != ""]
                color_palette = [
                    "#0f766e", "#2563eb", "#d97706", "#7c3aed",
                    "#dc2626", "#059669", "#4f46e5", "#ea580c",
                ]
                m_qty_map = df.groupby([month_col, UOM_COL], observed=False)[QTY_COL].sum().to_dict()
                datasets = []
                for idx, uom in enumerate(uoms):
                    d = [round(float(m_qty_map.get((m, uom), 0.0)), 2) for m in range(1, 13)]
                    color = color_palette[idx % len(color_palette)]
                    datasets.append({
                        "label": f"Qty ({uom})",
                        "data": d,
                        "backgroundColor": color,
                        "borderColor": color,
                        "borderWidth": 1,
                    })
                return {"labels": labels, "datasets": datasets, "meta": meta}

    # 2. Drill-down LEVEL 3: Weekly View (when single month and year are selected/drilled)
    elif granularity == "Weekly":
        single_year = None
        if len(valid_year_filters) == 1:
            single_year = valid_year_filters[0]
        elif year_col in df.columns and df[year_col].nunique() == 1:
            single_year = int(df[year_col].iloc[0])

        single_month = None
        if len(valid_month_filters) == 1:
            single_month = valid_month_filters[0]
        elif month_col in df.columns and df[month_col].nunique() == 1:
            single_month = int(df[month_col].iloc[0])

        if single_year is not None and single_month is not None:
            weeks = get_month_weeks(single_year, single_month)
            labels = [w["label"] for w in weeks]
            meta = weeks

            if measure == "Spend":
                data = []
                for w in weeks:
                    if date_col_iso in df.columns:
                        c = (df[date_col_iso] >= w["start_date"]) & (df[date_col_iso] <= w["end_date"])
                        sub = df[c]
                        w_spend = float(sub[SPEND_COL].sum()) if not sub.empty else 0.0
                    else:
                        w_spend = 0.0
                    data.append(round(w_spend, 2))

                return {
                    "labels": labels,
                    "datasets": [{
                        "label": "Spend (INR)",
                        "data": data,
                        "backgroundColor": "#1e3a8a",
                        "borderColor": "#172554",
                        "borderWidth": 1,
                    }],
                    "meta": meta,
                }
            else:
                uoms = [u for u in df[UOM_COL].unique().tolist() if u is not None and str(u) != ""]
                color_palette = [
                    "#0f766e", "#2563eb", "#d97706", "#7c3aed",
                    "#dc2626", "#059669", "#4f46e5", "#ea580c",
                ]
                datasets = []
                for idx, uom in enumerate(uoms):
                    d = []
                    for w in weeks:
                        if date_col_iso in df.columns:
                            c = (df[date_col_iso] >= w["start_date"]) & (df[date_col_iso] <= w["end_date"]) & (df[UOM_COL] == uom)
                            sub = df[c]
                            w_qty = float(sub[QTY_COL].sum()) if not sub.empty else 0.0
                        else:
                            w_qty = 0.0
                        d.append(round(w_qty, 2))
                    color = color_palette[idx % len(color_palette)]
                    datasets.append({
                        "label": f"Qty ({uom})",
                        "data": d,
                        "backgroundColor": color,
                        "borderColor": color,
                        "borderWidth": 1,
                    })
                return {"labels": labels, "datasets": datasets, "meta": meta}

    # 3. Drill-down LEVEL 4: Daily View (when calendar range or specific week is selected)
    elif granularity == "Daily" and from_date and to_date:
        try:
            start_d = datetime.strptime(str(from_date), "%Y-%m-%d").date()
            end_d = datetime.strptime(str(to_date), "%Y-%m-%d").date()
            if start_d <= end_d and (end_d - start_d).days <= 62:
                days = []
                cur = start_d
                while cur <= end_d:
                    days.append(cur)
                    cur += timedelta(days=1)

                labels = [d.strftime("%d %b %Y") for d in days]
                meta = [{"date": d.strftime("%Y-%m-%d"), "label": d.strftime("%d %b %Y")} for d in days]

                if measure == "Spend":
                    date_spend_map = df.groupby(date_col_iso, observed=False)[SPEND_COL].sum().to_dict()
                    data = [round(float(date_spend_map.get(d.strftime("%Y-%m-%d"), 0.0)), 2) for d in days]
                    return {
                        "labels": labels,
                        "datasets": [{
                            "label": "Spend (INR)",
                            "data": data,
                            "backgroundColor": "#1e3a8a",
                            "borderColor": "#172554",
                            "borderWidth": 1,
                        }],
                        "meta": meta,
                    }
                else:
                    uoms = [u for u in df[UOM_COL].unique().tolist() if u is not None and str(u) != ""]
                    color_palette = [
                        "#0f766e", "#2563eb", "#d97706", "#7c3aed",
                        "#dc2626", "#059669", "#4f46e5", "#ea580c",
                    ]
                    date_qty_map = df.groupby([date_col_iso, UOM_COL], observed=False)[QTY_COL].sum().to_dict()
                    datasets = []
                    for idx, uom in enumerate(uoms):
                        d = [round(float(date_qty_map.get((day.strftime("%Y-%m-%d"), uom), 0.0)), 2) for day in days]
                        color = color_palette[idx % len(color_palette)]
                        datasets.append({
                            "label": f"Qty ({uom})",
                            "data": d,
                            "backgroundColor": color,
                            "borderColor": color,
                            "borderWidth": 1,
                        })
                    return {"labels": labels, "datasets": datasets, "meta": meta}
        except Exception as exc:
            logger.warning("Error computing daily chart with custom range: %s", exc)

    # 4. Standard / Fallback Grouping (Level 1 Yearly, or non-drilldown Monthly/Weekly/Daily)
    label_col, sort_col = _get_period_cols(df, granularity, date_basis)
    if label_col not in df.columns or sort_col not in df.columns:
        return {"labels": [], "datasets": [], "meta": []}

    if measure == "Spend":
        grouped = df.groupby([sort_col, label_col], observed=False)[SPEND_COL].sum().reset_index()
        grouped = grouped.sort_values(by=sort_col)
        labels = [str(lbl) for lbl in grouped[label_col].tolist()]
        meta = [{"label": lbl, "year": lbl if granularity == "Yearly" else ""} for lbl in labels]

        return {
            "labels": labels,
            "datasets": [
                {
                    "label": "Spend (INR)",
                    "data": [round(float(v), 2) for v in grouped[SPEND_COL].tolist()],
                    "backgroundColor": "#1e3a8a",
                    "borderColor": "#172554",
                    "borderWidth": 1,
                }
            ],
            "meta": meta,
        }
    else:
        uoms = [u for u in df[UOM_COL].unique().tolist() if u is not None and str(u) != ""]
        periods_df = df[[sort_col, label_col]].drop_duplicates().sort_values(sort_col)
        labels = [str(lbl) for lbl in periods_df[label_col].tolist()]
        meta = [{"label": lbl, "year": lbl if granularity == "Yearly" else ""} for lbl in labels]

        color_palette = [
            "#0f766e", "#2563eb", "#d97706", "#7c3aed",
            "#dc2626", "#059669", "#4f46e5", "#ea580c",
        ]

        qty_map = df.groupby([label_col, UOM_COL], observed=False)[QTY_COL].sum().to_dict()

        datasets = []
        for idx, uom in enumerate(uoms):
            data = [round(float(qty_map.get((lbl, uom), 0.0)), 2) for lbl in labels]
            color = color_palette[idx % len(color_palette)]

            datasets.append({
                "label": f"Qty ({uom})",
                "data": data,
                "backgroundColor": color,
                "borderColor": color,
                "borderWidth": 1,
            })

        return {"labels": labels, "datasets": datasets, "meta": meta}


def _compute_breakdown_charts(
    df: pd.DataFrame,
    measure: str,
    top_vendors_limit: int = 50,
) -> dict[str, Any]:
    """Compute all 10 horizontal breakdown charts according to Rules CH3–CH10."""
    result = {}

    # 1. Import vs Domestic
    cat_im_dom = "ImportDomestic"
    if cat_im_dom not in df.columns:
        if CURRENCY_COL in df.columns:
            df[cat_im_dom] = np.where(df[CURRENCY_COL] == "INR", "Domestic", "Import")
        else:
            df[cat_im_dom] = "Domestic"
    result["import_domestic"] = _format_horizontal_chart(df, cat_im_dom, measure)

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

    # 9. Top Vendors + Others (ranked by Spend always, CH8)
    result["top_vendors"] = _compute_top_vendors_chart(df, measure, limit=top_vendors_limit)

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
        grouped = df.groupby(cat_col, observed=False)[SPEND_COL].sum().sort_values(ascending=False)
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
        cat_totals = df.groupby(cat_col, observed=False)[QTY_COL].sum().sort_values(ascending=False)
        labels = [str(k) for k in cat_totals.index.tolist()]
        uoms = [u for u in df[UOM_COL].unique().tolist() if u is not None and str(u) != ""]

        color_palette = [
            "#0f766e", "#2563eb", "#d97706", "#7c3aed",
            "#dc2626", "#059669", "#4f46e5", "#ea580c",
        ]

        # Fast single groupby across (cat_col, UOM_COL)
        cat_uom_map = df.groupby([cat_col, UOM_COL], observed=False)[QTY_COL].sum().to_dict()

        datasets = []
        for idx, uom in enumerate(uoms):
            data = [round(float(cat_uom_map.get((cat, uom), 0.0)), 2) for cat in labels]
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
    """Backward compatibility wrapper: compute Top 50 Vendors (CH8)."""
    return _compute_top_vendors_chart(df, measure, limit=50)


def _compute_top_vendors_chart(
    df: pd.DataFrame,
    measure: str,
    limit: int = 50,
) -> dict[str, Any]:
    """Compute Top N Vendors ranked by Spend, with Others (CH8)."""
    if VENDOR_COL not in df.columns or df.empty:
        return {"labels": [], "datasets": []}

    # Vendors are ALWAYS ranked by Spend (CH8)
    vendor_spend = df.groupby(VENDOR_COL, observed=False)[SPEND_COL].sum().sort_values(ascending=False)
    all_vendors = vendor_spend.index.tolist()

    if limit and limit > 0:
        top_vendors = all_vendors[:limit]
        others_vendors = all_vendors[limit:]
    else:
        top_vendors = all_vendors
        others_vendors = []

    if measure == "Spend":
        labels = [str(v) for v in top_vendors]
        data = [round(float(vendor_spend[v]), 2) for v in top_vendors]

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
        uoms = [u for u in df[UOM_COL].unique().tolist() if u is not None and str(u) != ""]
        labels = [str(v) for v in top_vendors]
        if others_vendors:
            labels.append(f"Others ({len(others_vendors)} vendors)")

        color_palette = [
            "#0f766e", "#2563eb", "#d97706", "#7c3aed",
            "#dc2626", "#059669", "#4f46e5", "#ea580c",
        ]

        # Fast single groupby across (VENDOR_COL, UOM_COL)
        vendor_uom_map = df.groupby([VENDOR_COL, UOM_COL], observed=False)[QTY_COL].sum().to_dict()

        datasets = []
        for idx, uom in enumerate(uoms):
            data = [round(float(vendor_uom_map.get((v, uom), 0.0)), 2) for v in top_vendors]
            if others_vendors:
                others_qty = sum(float(vendor_uom_map.get((v, uom), 0.0)) for v in others_vendors)
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
    f_hash = _hash_filters(filters)
    cache_key = (id(df), date_basis, f_hash)
    if cache_key in _facet_cache:
        return _facet_cache[cache_key]

    is_posting = (date_basis == "Posting Date")
    year_col = "Posting Year" if is_posting else "Vendor Doc Year"
    month_col = "Posting Month" if is_posting else "Vendor Doc Month"
    week_col = "Posting Week" if is_posting else "Vendor Doc Week"
    day_col = "Posting Day" if is_posting else "Vendor Doc Day"

    # Identify all active keys in filters
    active_keys = set()
    if filters.get("fromDate") or filters.get("toDate"):
        active_keys.add("calendar")
    for k in [
        "year", "month", "week", "day", "document", "documentType", "purchaseType", "docCurrency",
        "bpName", "vendorGroup", "industry", "vendorCity", "vendorState", "vendorCountry",
        "rowBuyer", "receivingState", "receivingCity", "itemGroup", "subGroup1", "subGroup2",
        "itemCode", "brand", "moc", "madeToOrder", "uom",
    ]:
        if filters.get(k):
            active_keys.add(k)

    item_attrs = filters.get("itemAttributes") or {}
    for attr in ITEM_ATTRIBUTE_COLUMNS:
        if item_attrs.get(attr):
            active_keys.add(f"attr_{attr}")

    # Base active mask for all filters that are NOT active
    base_mask = _get_active_filters_mask(df, date_basis, filters) if active_keys else None

    # Excluded masks only for the filters that are currently active
    excluded_masks = {}
    for k in active_keys:
        excluded_masks[k] = _get_active_filters_mask(df, date_basis, filters, exclude_key=k)

    filter_defs = [
        ("year", year_col, True),
        ("month", month_col, True),
        ("week", week_col, True),
        ("day", day_col, True),
        ("document", DOC_COL, False),
        ("documentType", "Document Type", False),
        ("purchaseType", PURCHASE_TYPE_COL, False),
        ("docCurrency", CURRENCY_COL, False),
        ("bpName", VENDOR_COL, False),
        ("vendorGroup", VENDOR_GROUP_COL, False),
        ("industry", "Industry", False),
        ("vendorCity", "Vendor City", False),
        ("vendorState", "Vendor State", False),
        ("vendorCountry", "Vendor Country", False),
        ("rowBuyer", BUYER_COL, False),
        ("receivingState", RECEIVING_STATE_COL, False),
        ("receivingCity", RECEIVING_CITY_COL, False),
        ("itemGroup", ITEM_GROUP_COL, False),
        ("subGroup1", SUB_GROUP1_COL, False),
        ("subGroup2", SUB_GROUP2_COL, False),
        ("itemCode", "Item Code", False),
        ("brand", BRAND_COL, False),
        ("moc", "MOC", False),
        ("madeToOrder", "Made To Order", False),
        ("uom", UOM_COL, False),
    ]
    for attr in ITEM_ATTRIBUTE_COLUMNS:
        filter_defs.append((f"attr_{attr}", attr, False))

    options: dict[str, Any] = {}
    options["itemAttributes"] = {}

    for f_key, col, is_num in filter_defs:
        if col not in df.columns:
            continue

        mask = excluded_masks.get(f_key, base_mask)
        series = df[col] if mask is None else df[col][mask]
        counts = series.value_counts().to_dict()

        selected = item_attrs.get(col) if f_key.startswith("attr_") else filters.get(f_key)
        selected = selected or []
        if not isinstance(selected, list):
            selected = [selected]
        selected_str = [str(s) for s in selected]

        items = []
        for val, cnt in counts.items():
            items.append({
                "value": str(val),
                "count": int(cnt),
                "is_stale": False,
            })

        existing_vals = {item["value"] for item in items}
        for sel in selected_str:
            if sel not in existing_vals:
                items.append({
                    "value": sel,
                    "count": 0,
                    "is_stale": True,
                })

        if is_num:
            items.sort(key=lambda x: int(x["value"]) if str(x["value"]).isdigit() else -1)
        else:
            items.sort(key=lambda x: (x["value"] == "(Blank)", x["value"]))

        if f_key.startswith("attr_"):
            options["itemAttributes"][col] = items
        else:
            options[f_key] = items

    _facet_cache[cache_key] = options
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
        return {"rows": [], "total_rows": 0, "page": 1, "total_pages": 0, "start_row": 0, "end_row": 0}

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

    cache_key = (id(df), sort_column, sort_direction.lower())
    if cache_key in _table_cache:
        df_sorted, total_rows = _table_cache[cache_key]
    else:
        df_sorted = df
        if sort_column in col_map and col_map[sort_column] in df.columns:
            actual_col = col_map[sort_column]
            ascending = (sort_direction.lower() == "asc")
            df_sorted = df.sort_values(by=actual_col, ascending=ascending)
        _table_cache[cache_key] = (df_sorted, total_rows)

    page = max(1, page)
    start_idx = (page - 1) * page_size
    end_idx = min(start_idx + page_size, total_rows)
    paged_df = df_sorted.iloc[start_idx:end_idx]

    rows = []
    start_row = start_idx + 1

    for row in paged_df.itertuples(index=False):
        row_dict = row._asdict() if hasattr(row, "_asdict") else dict(zip(paged_df.columns, row))
        qty_val = row_dict.get(QTY_COL)
        spend_val = row_dict.get(SPEND_COL)

        rows.append({
            "#": start_row + len(rows),
            "DocNum": int(row_dict.get("DocNum", 0)) if pd.notnull(row_dict.get("DocNum")) else "-",
            "Document": str(row_dict.get(DOC_COL, "")),
            "Document Type": str(row_dict.get("Document Type", "")),
            "Posting Date": str(row_dict.get("Posting_Date_Formatted", "")),
            "Vendors Doc Date": str(row_dict.get("Vendor_Doc_Date_Formatted", "")),
            "BP Name": str(row_dict.get(VENDOR_COL, "")),
            "Item Code": str(row_dict.get("Item Code", "")),
            "Quantity": f"{float(qty_val):,.2f}" if (qty_val is not None and pd.notnull(qty_val)) else "-",
            "UoM": str(row_dict.get(UOM_COL, "")),
            "Row Total (After Doc Disc)": f"₹{float(spend_val):,.2f}" if (spend_val is not None and pd.notnull(spend_val)) else "-",
            "Vendors Doc No.": str(row_dict.get("Vendors Doc No.", "")),
            "Row Buyer": str(row_dict.get(BUYER_COL, "")),
        })

    total_pages = (total_rows + page_size - 1) // page_size
    return {
        "rows": rows,
        "total_rows": total_rows,
        "page": page,
        "total_pages": total_pages,
        "start_row": start_row if total_rows > 0 else 0,
        "end_row": end_idx,
    }


def _sync_query_procurement_data(
    df: pd.DataFrame,
    granularity: str,
    measure: str,
    date_basis: str,
    filters: dict[str, Any],
    page: int,
    page_size: int,
    sort_column: str,
    sort_direction: str,
    intent: str = "all",
    top_vendors_limit: int = 50,
) -> dict[str, Any]:
    """Synchronous core query engine executed inside worker threadpool."""
    t_start = time.perf_counter()

    # Ensure precomputed columns exist (in case df was provided by test mock)
    _precompute_dataframe_columns(df)

    # 1. Filter mask
    t0 = time.perf_counter()
    f_hash = _hash_filters(filters)
    mask_key = (id(df), date_basis, f_hash)

    if mask_key in _mask_cache:
        active_mask = _mask_cache[mask_key]
    else:
        active_mask = _get_active_filters_mask(df, date_basis, filters)
        _mask_cache[mask_key] = active_mask

    filtered_df = df if active_mask is None else df[active_mask]
    filtered_count = len(filtered_df)
    t_mask = time.perf_counter() - t0

    # Calculate filtered total spend
    filtered_spend = float(filtered_df[SPEND_COL].sum()) if (SPEND_COL in filtered_df.columns and filtered_count > 0) else 0.0

    # Fast path: Intent == "granularity"
    if intent == "granularity":
        t0 = time.perf_counter()
        main_chart = _compute_main_chart(filtered_df, granularity, measure, date_basis, filters=filters)
        t_main = time.perf_counter() - t0
        t_total = time.perf_counter() - t_start

        logger.info(
            "PROFILING_QUERY [intent=granularity] | mask=%.4fs | main_chart=%.4fs | total=%.4fs",
            t_mask, t_main, t_total
        )
        return {
            "record_count": filtered_count,
            "total_spend": filtered_spend,
            "main_chart": main_chart,
        }

    # Fast path: Intent == "table"
    if intent == "table":
        t0 = time.perf_counter()
        table_data = _compute_detail_table(filtered_df, page, page_size, sort_column, sort_direction)
        t_table = time.perf_counter() - t0
        t_total = time.perf_counter() - t_start

        logger.info(
            "PROFILING_QUERY [intent=table] | mask=%.4fs | table=%.4fs | total=%.4fs",
            t_mask, t_table, t_total
        )
        return {
            "record_count": filtered_count,
            "table_data": table_data,
        }

    # Fast path: Intent == "measure"
    if intent == "measure":
        t0 = time.perf_counter()
        main_chart = _compute_main_chart(filtered_df, granularity, measure, date_basis, filters=filters)
        t_main = time.perf_counter() - t0

        t0 = time.perf_counter()
        bd_key = (id(df), date_basis, f_hash, measure, top_vendors_limit)
        if bd_key in _breakdown_cache:
            breakdown_charts = _breakdown_cache[bd_key]
        else:
            breakdown_charts = _compute_breakdown_charts(filtered_df, measure, top_vendors_limit=top_vendors_limit)
            _breakdown_cache[bd_key] = breakdown_charts
        t_bd = time.perf_counter() - t0
        t_total = time.perf_counter() - t_start

        logger.info(
            "PROFILING_QUERY [intent=measure] | mask=%.4fs | main=%.4fs | breakdown=%.4fs | total=%.4fs",
            t_mask, t_main, t_bd, t_total
        )
        return {
            "record_count": filtered_count,
            "total_spend": filtered_spend,
            "total_spend_formatted": f"₹{filtered_spend:,.2f}",
            "main_chart": main_chart,
            "breakdown_charts": breakdown_charts,
        }

    # Intent == "all" (or unspecified)
    # Handle No Data (FT11)
    if filtered_count == 0:
        filter_options = _compute_filter_options(df, date_basis, filters)
        t_total = time.perf_counter() - t_start
        logger.info("PROFILING_QUERY [intent=all, no_data] | total=%.4fs", t_total)
        return {
            "record_count": 0,
            "total_spend": 0.0,
            "total_spend_formatted": "₹0.00",
            "data_as_of": data_store.data_as_of_formatted,
            "main_chart": {"labels": [], "datasets": []},
            "breakdown_charts": {},
            "filter_options": filter_options,
            "table_data": {"rows": [], "total_rows": 0, "page": page, "total_pages": 0, "start_row": 0, "end_row": 0},
            "no_data": True,
        }

    # 2. Filter options (cached or computed fast)
    t0 = time.perf_counter()
    filter_options = _compute_filter_options(df, date_basis, filters)
    t_options = time.perf_counter() - t0

    # 3. Main chart
    t0 = time.perf_counter()
    main_chart = _compute_main_chart(filtered_df, granularity, measure, date_basis, filters=filters)
    t_main = time.perf_counter() - t0

    # 4. Breakdown charts (cached by dataframe id, date_basis, filter_hash, measure, top_vendors_limit)
    t0 = time.perf_counter()
    bd_key = (id(df), date_basis, f_hash, measure, top_vendors_limit)
    if bd_key in _breakdown_cache:
        breakdown_charts = _breakdown_cache[bd_key]
    else:
        breakdown_charts = _compute_breakdown_charts(filtered_df, measure, top_vendors_limit=top_vendors_limit)
        _breakdown_cache[bd_key] = breakdown_charts
    t_bd = time.perf_counter() - t0

    # 5. Detail table
    t0 = time.perf_counter()
    table_data = _compute_detail_table(filtered_df, page, page_size, sort_column, sort_direction)
    t_table = time.perf_counter() - t0

    t_total = time.perf_counter() - t_start

    logger.info(
        "PROFILING_QUERY [intent=all] | mask=%.4fs | filter_opts=%.4fs | main=%.4fs | breakdown=%.4fs | table=%.4fs | total=%.4fs",
        t_mask, t_options, t_main, t_bd, t_table, t_total
    )

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


async def query_procurement_data(
    granularity: str = "Monthly",
    measure: str = "Spend",
    date_basis: str = "Posting Date",
    filters: dict[str, Any] | None = None,
    page: int = 1,
    page_size: int = 50,
    sort_column: str = "Posting Date",
    sort_direction: str = "desc",
    intent: str = "all",
    top_vendors_limit: int = 50,
) -> dict[str, Any]:
    """
    Optimized in-memory query engine:
    - Filters data using active Stage 1, 2, and 3 filters
    - Selective calculation based on query intent (granularity, measure, table, all)
    - Offloaded to worker thread via asyncio.to_thread to keep FastAPI event loop non-blocking
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
            "table_data": {"rows": [], "total_rows": 0, "page": page, "total_pages": 0, "start_row": 0, "end_row": 0},
            "no_data": True,
        }

    return await asyncio.to_thread(
        _sync_query_procurement_data,
        df=df,
        granularity=granularity,
        measure=measure,
        date_basis=date_basis,
        filters=filters,
        page=page,
        page_size=page_size,
        sort_column=sort_column,
        sort_direction=sort_direction,
        intent=intent,
        top_vendors_limit=top_vendors_limit,
    )
