"""
Tests for FastAPI application endpoints, health checks, and direct access routing.
Verifies that the application operates as a simple, normal dashboard without SSO.
"""
from unittest.mock import AsyncMock, patch
import pytest
from starlette.testclient import TestClient
from app.main import app
from app.config import settings

client = TestClient(app)


def test_health_endpoints():
    """Verify /health and /healthz endpoints are active and public for both GET and HEAD."""
    r1 = client.get("/health")
    r2 = client.get("/healthz")

    assert r1.status_code == 200
    assert r1.json()["status"] == "ok"
    assert r1.json()["app"] == settings.app_name

    assert r2.status_code == 200
    assert r2.json()["status"] == "ok"

    # Test HEAD requests (vital for Render and cloud load balancers)
    h_root = client.head("/")
    h_health = client.head("/health")
    h_healthz = client.head("/healthz")

    assert h_root.status_code == 200
    assert h_health.status_code == 200
    assert h_healthz.status_code == 200


def test_legacy_sso_routes_redirect_to_dashboard():
    """Verify old SSO/auth routes cleanly redirect to the main dashboard."""
    r_login = client.get("/sso/login", follow_redirects=False)
    r_logout = client.get("/sso/logout", follow_redirects=False)
    r_launch = client.post("/auth/launch", follow_redirects=False)

    assert r_login.status_code == 303
    assert r_login.headers["location"] == "/"

    assert r_logout.status_code == 303
    assert r_logout.headers["location"] == "/"

    assert r_launch.status_code == 303
    assert r_launch.headers["location"] == "/"


def test_dashboard_direct_access_without_sso():
    """Verify the dashboard landing page is directly accessible without any authentication."""
    mock_summary = {
        "record_count": 100,
        "total_spend": 50000.0,
        "total_spend_formatted": "₹50,000.00",
        "data_as_of_formatted": "2026-11-06 12:00:00",
        "database": "Test_OperationsDB",
        "sample_records": [],
        "columns": [],
        "uom_summary": [],
        "error": None,
    }

    with patch("app.routers.dashboard.get_procurement_summary", new=AsyncMock(return_value=mock_summary)):
        resp = client.get("/")

    assert resp.status_code == 200
    assert "Procurement Dashboard" in resp.text
    # Ensure no SSO login button or user dropdown exists in HTML
    assert "Logged in via One Portal" not in resp.text


def test_api_summary_direct_access_without_sso():
    """Verify summary API endpoint returns data without requiring tokens or sessions."""
    mock_summary = {
        "record_count": 42,
        "total_spend": 12345.67,
        "total_spend_formatted": "₹12,345.67",
        "data_as_of_formatted": "2026-11-06 12:00:00",
        "database": "Test_OperationsDB",
        "sample_records": [],
        "columns": [],
        "uom_summary": [],
        "error": None,
    }

    with patch("app.routers.dashboard.get_procurement_summary", new=AsyncMock(return_value=mock_summary)):
        resp = client.get("/api/procurement/summary")

    assert resp.status_code == 200
    data = resp.json()
    assert data["record_count"] == 42
    assert data["total_spend"] == 12345.67
