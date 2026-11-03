"""
Tests for FastAPI application endpoints, health checks, and middleware.
"""
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from app.config import settings


@pytest.mark.asyncio
async def test_health_endpoints():
    """Verify /health and /healthz endpoints are active and public."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r1 = await ac.get("/health")
        r2 = await ac.get("/healthz")

    assert r1.status_code == 200
    assert r1.json()["status"] == "ok"
    assert r1.json()["app"] == settings.app_name

    assert r2.status_code == 200
    assert r2.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_sso_login_page_accessible():
    """Verify login page renders with HTTP 200."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/sso/login")

    assert resp.status_code == 200
    assert "Procurement Dashboard" in resp.text
    assert "One Portal" in resp.text


@pytest.mark.asyncio
async def test_sso_logout_clears_cookie():
    """Verify logout deletes session cookie and redirects."""
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", follow_redirects=False
    ) as ac:
        resp = await ac.get("/sso/logout")

    assert resp.status_code == 303
    assert resp.headers["location"] == "/sso/login"
    # Cookie should be cleared
    set_cookie = resp.headers.get("set-cookie", "")
    assert "procurement_sso_session" in set_cookie


@pytest.mark.asyncio
async def test_unauthenticated_api_request_when_auth_enforced(monkeypatch):
    """When ONE_PORTAL_AUTH_ENABLED=True, unauthenticated API calls return 401."""
    monkeypatch.setattr(settings, "one_portal_auth_enabled", True)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/procurement/summary")

    assert resp.status_code == 401
    assert "detail" in resp.json()
