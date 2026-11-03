"""
Unit tests for Milestone 2: Dashboard UI components, gating, and elements.
"""
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest.mark.asyncio
async def test_dashboard_ui_stage1_and_stage2_controls():
    """Verify Stage 1 (Granularity & Measure) and Stage 2 (Date Basis) controls are present."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/")

    assert resp.status_code == 200
    html = resp.text

    # Stage 1: Granularity options
    assert 'id="granDaily"' in html
    assert 'id="granWeekly"' in html
    assert 'id="granMonthly"' in html
    assert 'id="granYearly"' in html

    # Stage 1: Measure options
    assert 'id="measSpend"' in html
    assert 'id="measQuantity"' in html

    # Stage 2: Date Basis options
    assert 'id="basisPostingDate"' in html
    assert 'id="basisVendorDocDate"' in html


@pytest.mark.asyncio
async def test_dashboard_ui_selection_prompt_and_gating():
    """Verify prompt card exists for FL3 gating and main content starts hidden."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/")

    html = resp.text
    assert 'id="selectionPromptCard"' in html
    assert 'id="dashboardMainContent"' in html
    assert 'style="display: none;"' in html


@pytest.mark.asyncio
async def test_dashboard_ui_buttons_and_header():
    """Verify Refresh Data and Reset Filters are two separate buttons (DL5) and timestamp exists."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/")

    html = resp.text
    assert 'id="btnRefreshData"' in html
    assert 'id="btnResetFilters"' in html
    assert 'id="dataAsOfText"' in html


@pytest.mark.asyncio
async def test_dashboard_ui_all_eight_filter_sections():
    """Verify all 8 filter sections (FT1-1 through FT1-8) are present in the DOM."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/")

    html = resp.text

    # Section 1: Period
    assert 'headingPeriod' in html
    assert 'id="filterFromDate"' in html
    assert 'id="filterToDate"' in html
    assert 'id="filterYear"' in html
    assert 'id="filterMonth"' in html
    assert 'id="filterWeek"' in html
    assert 'id="filterDay"' in html

    # Section 2: Document & Terms
    assert 'headingDocTerms' in html
    assert 'id="filterDocument"' in html
    assert 'id="filterDocumentType"' in html
    assert 'id="filterPurchaseType"' in html
    assert 'id="filterDocCurrency"' in html

    # Section 3: Vendor
    assert 'headingVendor' in html
    assert 'id="filterBPName"' in html
    assert 'id="filterVendorGroup"' in html
    assert 'id="filterIndustry"' in html
    assert 'id="filterVendorCity"' in html
    assert 'id="filterVendorState"' in html
    assert 'id="filterVendorCountry"' in html

    # Section 4: Buyer
    assert 'headingBuyer' in html
    assert 'id="filterRowBuyer"' in html

    # Section 5: Receiving Location
    assert 'headingReceiving' in html
    assert 'id="filterReceivingState"' in html
    assert 'id="filterReceivingCity"' in html

    # Section 6: Item Groups
    assert 'headingItemGroups' in html
    assert 'id="filterItemGroup"' in html
    assert 'id="filterSubGroup1"' in html
    assert 'id="filterSubGroup2"' in html

    # Section 7: Item General
    assert 'headingItemGeneral' in html
    assert 'id="filterItemCode"' in html
    assert 'id="filterBrand"' in html
    assert 'id="filterMOC"' in html
    assert 'id="filterMadeToOrder"' in html
    assert 'id="filterUoM"' in html

    # Section 8: Item Attributes
    assert 'headingItemAttributes' in html
    assert 'id="itemAttributesContainer"' in html


@pytest.mark.asyncio
async def test_dashboard_ui_main_and_ten_breakdown_charts():
    """Verify main chart and all 10 breakdown charts (CH1, CH3) are present in the DOM."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/")

    html = resp.text

    # Main chart
    assert 'id="mainChartCanvas"' in html

    # 10 breakdown charts
    assert 'id="chartImportDomestic"' in html
    assert 'id="chartReceivingState"' in html
    assert 'id="chartItemGroup"' in html
    assert 'id="chartSubGroup1"' in html
    assert 'id="chartSubGroup2"' in html
    assert 'id="chartBrand"' in html
    assert 'id="chartBuyer"' in html
    assert 'id="chartPurchaseType"' in html
    assert 'id="chartTopVendors"' in html
    assert 'id="chartVendorGroup"' in html


@pytest.mark.asyncio
async def test_dashboard_ui_detail_table_thirteen_columns():
    """Verify detail table has exactly 13 columns in order (TB3)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/")

    html = resp.text
    assert 'id="detailTable"' in html

    expected_cols = [
        'data-col="#"',
        'data-col="DocNum"',
        'data-col="Document"',
        'data-col="Document Type"',
        'data-col="Posting Date"',
        'data-col="Vendors Doc Date"',
        'data-col="BP Name"',
        'data-col="Item Code"',
        'data-col="Quantity"',
        'data-col="UoM"',
        'data-col="Row Total (After Doc Disc)"',
        'data-col="Vendors Doc No."',
        'data-col="Row Buyer"',
    ]

    for col in expected_cols:
        assert col in html
