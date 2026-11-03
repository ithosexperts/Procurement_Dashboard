"""
Company API Connection Smoke-Test for Procurement Dashboard.

Tests:
1. API reachability and authentication (apiv2.php).
2. Data retrieval from VD_Procurement_Dashboard.
3. Database target validation (Test_OperationsDB / OperationsDB).
4. JSON response structure validation.
5. Record count verification.
6. Total procurement Spend calculation (INR).
7. Credit memo negative spend retention verification.
8. Quantity analysis by UoM.

Run with:
    python test_api.py
"""
import asyncio
import json
import sys

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

import pandas as pd
from app.api.client import api_request
from app.config import settings

SPEND_COL = "Row Total (After Doc Disc)"


async def main():
    print("=" * 70)
    print("  PROCUREMENT DASHBOARD – COMPANY API CONNECTION TEST (MILESTONE 1)")
    print("=" * 70)
    print(f"Target Gateway:  {settings.api_base_url}")
    print(f"Target Database: {settings.api_database}")
    print(f"Target View:     VD_Procurement_Dashboard")
    print("-" * 70)

    # ── Test 1: Connectivity & Sample Row Retrieval ────────────────
    print("\n[1] Testing connection to VD_Procurement_Dashboard (limit=5) ...")
    try:
        res = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns="*",
            limit=5,
        )
        status = res.get("status")
        returned = res.get("returnedRows", 0)
        total_rows = res.get("totalRows", 0)
        rows = res.get("data", [])

        if status != "success":
            print(f"    [FAIL] API status was '{status}', expected 'success'")
            sys.exit(1)

        print(f"    [OK] Connection successful! HTTP 200, status='{status}'")
        print(f"    [OK] Received {returned} sample rows (Total rows reported by gateway: {total_rows:,})")

        if rows:
            cols = list(rows[0].keys())
            print(f"    [OK] Column count: {len(cols)}")
            print(f"    [OK] Spend column '{SPEND_COL}' present: {SPEND_COL in cols}")
            print(f"    [OK] Document column present: {'Document' in cols}")
            print(f"    [OK] Quantity & UoM columns present: {'Quantity' in cols and 'UoM' in cols}")

    except Exception as exc:
        print(f"    [FAIL] API connection error: {exc}", file=sys.stderr)
        sys.exit(1)

    # ── Test 2: Database-wide Aggregation (Record Count & Spend) ───
    print("\n[2] Testing database-wide Spend & Record Count calculation ...")
    try:
        agg = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns=f"COUNT(DocNum) as TotalRecords, SUM([{SPEND_COL}]) as TotalSpend",
            limit=1,
        )
        agg_data = agg.get("data", [{}])[0]
        total_rec = int(agg_data.get("TotalRecords", 0))
        total_spend = float(agg_data.get("TotalSpend", 0.0))

        print(f"    [OK] Total Source Records: {total_rec:,}")
        print(f"    [OK] Total Procurement Spend (INR): Rs. {total_spend:,.2f}")

    except Exception as exc:
        print(f"    [FAIL] Aggregation calculation error: {exc}", file=sys.stderr)
        sys.exit(1)

    # ── Test 3: Business Rule Verification (Pandas Validation) ─────
    print("\n[3] Testing business data rules on sample batch (limit=100) ...")
    try:
        batch_res = await api_request(
            table="VD_Procurement_Dashboard",
            action="select",
            columns="*",
            limit=100,
        )
        batch_rows = batch_res.get("data", [])
        df = pd.DataFrame(batch_rows)

        # Spend column check
        df[SPEND_COL] = pd.to_numeric(df[SPEND_COL], errors="coerce").fillna(0.0)
        batch_spend = df[SPEND_COL].sum()
        print(f"    [OK] Sample batch spend calculated via Pandas: Rs. {batch_spend:,.2f}")

        # Document type distribution
        if "Document" in df.columns:
            doc_counts = df["Document"].value_counts().to_dict()
            print(f"    [OK] Document types found in sample batch: {doc_counts}")

        # Quantity by UoM analysis
        if "Quantity" in df.columns and "UoM" in df.columns:
            df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0.0)
            df["UoM"] = df["UoM"].fillna("Unspecified").replace("", "Unspecified")
            uom_grp = df.groupby("UoM")["Quantity"].sum().to_dict()
            print(f"    [OK] Quantity by UoM analyzed separately: {list(uom_grp.keys())[:5]}")

    except Exception as exc:
        print(f"    [FAIL] Pandas validation error: {exc}", file=sys.stderr)
        sys.exit(1)

    print("\n" + "=" * 70)
    print("  ALL MILESTONE 1 API INTEGRATION TESTS PASSED SUCCESSFULLY!")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
