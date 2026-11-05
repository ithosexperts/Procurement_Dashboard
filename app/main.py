"""
Procurement Dashboard - FastAPI Application Entrypoint.

Independent Procurement Analytics application for HoseXperts.
Follows FMS Portal architecture, coding conventions, authentication,
and API integration patterns.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.api.client import ApiError
from app.config import settings
from app.middleware.oneportal_auth import OnePortalAuthMiddleware
from app.routers import dashboard, sso
from app.templates_config import templates

# ── Logging Setup ──────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
# Suppress noisy HTTP request logging containing URL query params
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("procurement_dashboard")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Booting %s (env=%s, db=%s)",
        settings.app_name,
        settings.environment,
        settings.api_database,
    )
    yield
    logger.info("Shutting down %s", settings.app_name)


app = FastAPI(
    title=settings.app_name,
    docs_url="/docs" if not settings.is_production else None,
    redoc_url=None,
    lifespan=lifespan,
)

# ── Middleware (last added = first executed) ───────────────────
app.add_middleware(OnePortalAuthMiddleware)
app.add_middleware(SessionMiddleware, secret_key=settings.secret_key)

# ── Static Files ───────────────────────────────────────────────
STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ── Routers ────────────────────────────────────────────────────
app.include_router(sso.router)
app.include_router(dashboard.router)


# ── Health-check Endpoints ─────────────────────────────────────
@app.get("/health")
@app.get("/healthz")
async def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "environment": settings.environment,
        "database": settings.api_database,
    }


# ── Exception Handlers ─────────────────────────────────────────
@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    logger.error("API error handling request %s: %s", request.url.path, exc)
    if request.url.path.startswith("/api/"):
        return JSONResponse(
            status_code=502,
            content={"error": "Company API Gateway Error", "detail": str(exc)},
        )
    return templates.TemplateResponse(
        request,
        "dashboard/index.html",
        {
            "user": getattr(request.state, "identity", None),
            "record_count": 0,
            "total_spend": 0.0,
            "total_spend_formatted": "₹0.00",
            "data_as_of": "",
            "database": settings.api_database,
            "sample_records": [],
            "columns": [],
            "uom_summary": [],
            "error": str(exc),
        },
        status_code=502,
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s: %s", request.url.path, exc)
    if request.url.path.startswith("/api/"):
        return JSONResponse(
            status_code=500,
            content={"error": "Internal Server Error"},
        )
    msg = (
        f"{type(exc).__name__}: {exc}"
        if not settings.is_production
        else "An unexpected error occurred. The server error has been logged."
    )
    return HTMLResponse(
        f"<!DOCTYPE html><html><body style='font-family:Arial;padding:32px;'>"
        f"<h2>Error</h2><p>{msg}</p>"
        f"<p><a href='/'>Return to Dashboard</a></p>"
        f"</body></html>",
        status_code=500,
    )
