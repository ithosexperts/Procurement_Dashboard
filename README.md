# Procurement Dashboard – HoseXperts

An independent, enterprise-grade Procurement Analytics Dashboard application for HoseXperts.

- **GitHub Repository**: [https://github.com/ithosexperts/Procurement_Dashboard.git](https://github.com/ithosexperts/Procurement_Dashboard.git)
- **Reference Application**: FMS Portal ([https://github.com/ithosexperts/FMS_Portal](https://github.com/ithosexperts/FMS_Portal))

---

## 1. Technology Stack

| Layer | Technology | Details |
|---|---|---|
| **Backend** | Python 3.11+, FastAPI, HTTPX, Pandas | REST service, data aggregation, API client |
| **Frontend** | HTML5, CSS3, JavaScript, Bootstrap 5, Chart.js | Responsive analytics dashboard UI |
| **Application Type** | Standalone Web Application | Direct access analytics portal without SSO or role gating |
| **Data Source** | HoseXperts Company API (`apiv2.php`) | SQL View: `VD_Procurement_Dashboard` |
| **Deployment** | Render (`render.yaml`) | Free / Starter Python web service |

---

## 2. Project Directory Structure

```text
Procurement_Dashboard/
    app/
        __init__.py
        main.py                     # FastAPI application entry point, middleware, routes
        config.py                   # Pydantic Settings reading environment variables
        templates_config.py         # Jinja2 templates shared instance
        api/
            __init__.py
            client.py               # Company API client (apiv2.php gateway)
        auth/
            __init__.py
            request_context.py      # ContextVar storage for request identity & target DB
        routers/
            __init__.py
            dashboard.py            # Dashboard HTML view and summary JSON API
        services/
            __init__.py
            procurement_service.py  # Procurement metric calculation, UoM aggregation
        templates/
            base.html               # Shared layout, navbar, Chart.js & Bootstrap assets
            dashboard/
                index.html          # Executive summary KPI cards, UoM breakdown, data preview
        static/
            css/
                styles.css          # Custom styling and branding
            js/
                app.js              # Frontend interactive scripts
            images/
    tests/
        test_app.py                 # Health checks, public routes, direct access tests
        test_procurement_service.py # Aggregation logic, credit memo negative spend, error handling
    test_api.py                     # Standalone API smoke-test script
    requirements.txt                # Python package dependencies
    pytest.ini                      # Pytest runner configuration
    render.yaml                     # Infrastructure as code for Render deployment
    .env.example                    # Environment variable template
    .gitignore                      # Version control exclusions
    README.md                       # Complete documentation
```

---

## 3. Business Data Rules

The source view `VD_Procurement_Dashboard` aggregates procurement transactions from **AP Invoices** and **AP Credit Memos**. The application strictly adheres to the following business rules:

1. **Spend Calculation**: `Spend = Row Total (After Doc Disc)`.
2. **Credit Memos**: Retain negative spend values. Never apply `abs()` or invert signs.
3. **Quantity Separation**: Quantities are isolated and analysed strictly by Unit of Measure (`UoM`). Never aggregate quantities across mismatched units.
4. **Currency**: All monetary values are denominated in **INR (₹)**.
5. **Tax & Freight Exclusions**: GST and document-header freight are already excluded in the source SQL view.
6. **Data Integrity**: Source business rules are strictly preserved without independent recalculation.

---

## 4. First Development Milestone Status

All items of Development Milestone 1 are implemented and verified:

- [x] **1. Working FastAPI application**: Configured with lifespan management, CORS/Session middleware, exception handlers.
- [x] **2. Health-check endpoints**: `GET /health` and `GET /healthz` returning status, environment, and active database.
- [x] **3. Basic company SSO integration structure**: Full One Portal ticket launch flow (`/auth/launch`), replay prevention, signed cookie session management, and logout.
- [x] **4. Company API client**: Low-level `api_request` helper targeting `https://api.hosexperts.com:85/apiv2.php` with bearer token support, query/json formatting, and error handling.
- [x] **5. Procurement data service**: `get_procurement_summary()` in `procurement_service.py` performing database-level aggregation and sample-level Pandas validation.
- [x] **6. API connection test**: Standalone smoke-test `test_api.py` validating live connectivity, column integrity, and spend summation.
- [x] **7. Data retrieval from `VD_Procurement_Dashboard`**: Successfully connected to `Test_OperationsDB` and `OperationsDB`.
- [x] **8. JSON response validation**: Gateway response structure validated (`returnedRows`, `totalRows`, `totalPages`, `data`).
- [x] **9. Record count display**: Live source record count verified (**70,640 records**).
- [x] **10. Total procurement Spend calculation**: Verified spend calculation (**₹1,745,447,084.31 INR**).
- [x] **11. Data as of timestamp**: Real-time ISO-8601 UTC timestamp rendered on both the UI and JSON endpoints.

---

## 5. Standalone Direct Access Architecture

Procurement Dashboard is designed as a standalone, normal analytics web application:

1. **Direct Access**: Does not require Single Sign-On (SSO) ticket launch, external authentication tokens, or login credentials.
2. **Open Analytics**: All KPI metrics, interactive period charts, 10 breakdown charts, cascading multi-select filters, and the 13-column detailed transactions table are directly accessible upon visiting `/`.
3. **No Role Gatekeeping**: Users have immediate, unrestricted access to the analytics tools, in-memory dataset refresh, and filter resets without role barriers.
4. **Seamless Legacy Routing**: Any incoming legacy SSO/auth requests (e.g., `/sso/login`, `/sso/logout`, `/auth/launch`) cleanly redirect straight to the main dashboard (`/`).

---

## 6. Local Setup and Execution

### Step 1: Clone and Set Up Virtual Environment

```bash
git clone https://github.com/ithosexperts/Procurement_Dashboard.git
cd Procurement_Dashboard

python -m venv .venv
# On Windows:
.\.venv\Scripts\activate
# On Linux/macOS:
# source .venv/bin/activate

pip install -r requirements.txt
```

### Step 2: Configure Environment Variables

```bash
copy .env.example .env   # On Windows
# cp .env.example .env   # On Linux/macOS
```

Edit `.env` to configure your settings (defaults will connect to the live validation endpoint):
```ini
API_BASE_URL=https://api.hosexperts.com:85/apiv2.php
API_DATABASE=Test_OperationsDB
ONE_PORTAL_AUTH_ENABLED=false
```

### Step 3: Run the Company API Smoke-Test

```bash
python test_api.py
```

Expected output:
```text
======================================================================
  PROCUREMENT DASHBOARD – COMPANY API CONNECTION TEST (MILESTONE 1)
======================================================================
Target Gateway:  https://api.hosexperts.com:85/apiv2.php
Target Database: Test_OperationsDB
Target View:     VD_Procurement_Dashboard
----------------------------------------------------------------------
[1] Testing connection to VD_Procurement_Dashboard (limit=5) ...
    [OK] Connection successful! HTTP 200, status='success'
    [OK] Received 5 sample rows (Total rows reported by gateway: 70,640)
    [OK] Column count: 56
...
[2] Testing database-wide Spend & Record Count calculation ...
    [OK] Total Source Records: 70,640
    [OK] Total Procurement Spend (INR): Rs. 1,745,447,084.31
======================================================================
  ALL MILESTONE 1 API INTEGRATION TESTS PASSED SUCCESSFULLY!
======================================================================
```

### Step 4: Run the Automated Test Suite

```bash
pytest tests/ -v
```

All 12 unit tests will execute and pass:
```text
============================= 12 passed in 2.81s ==============================
```

### Step 5: Start the Development Server

```bash
uvicorn app.main:app --reload --port 8000
```

Open your browser to:
- Dashboard: [http://localhost:8000/](http://localhost:8000/)
- Health Check: [http://localhost:8000/health](http://localhost:8000/health)
- Summary JSON API: [http://localhost:8000/api/procurement/summary](http://localhost:8000/api/procurement/summary)
- SSO Login Page: [http://localhost:8000/sso/login](http://localhost:8000/sso/login)

---

## 7. Render Deployment

The repository includes a production-ready `render.yaml` configuration.

To deploy on Render:
1. Push this repository to GitHub (`https://github.com/ithosexperts/Procurement_Dashboard.git`).
2. In the Render Dashboard, select **New -> Blueprint**.
3. Connect the `Procurement_Dashboard` repository.
4. Render will automatically detect `render.yaml` and configure the Python web service.
5. In Render's Environment Settings, supply the secret parameters:
   - `PROCUREMENT_SSO_SECRET`: 48+ character secret registered in One Portal.
   - `API_AUTH_TOKEN` / `API_USERNAME` / `API_PASSWORD`: If upstream gateway authentication is required.
   - `API_DATABASE`: `OperationsDB` for production.
