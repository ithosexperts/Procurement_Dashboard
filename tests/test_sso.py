"""
Unit tests for One Portal SSO session helpers and replay protection.
"""
import time
import jwt
import pytest
from app.auth import sso_session
from app.config import settings


@pytest.fixture(autouse=True)
def setup_sso_env(monkeypatch):
    test_secret = "test-secret-at-least-32-chars-long-for-hmac-sha256"
    monkeypatch.setattr(settings, "procurement_sso_secret", test_secret)
    monkeypatch.setattr(settings, "sso_ticket_audience", "procurement-dashboard")


def test_safe_next_path():
    """Verify open-redirect protection."""
    assert sso_session.safe_next_path("/dashboard") == "/dashboard"
    assert sso_session.safe_next_path("/") == "/"
    assert sso_session.safe_next_path("//evil.com") == "/"
    assert sso_session.safe_next_path("https://evil.com") == "/"
    assert sso_session.safe_next_path("/auth/launch") == "/"
    assert sso_session.safe_next_path("/sso/login") == "/"
    assert sso_session.safe_next_path("javascript:alert(1)") == "/"


def test_decode_ticket_valid():
    """Valid One Portal launch ticket decodes correctly."""
    now = int(time.time())
    secret = settings.procurement_sso_secret
    payload = {
        "iss": "one-portal",
        "aud": "procurement-dashboard",
        "exp": now + 60,
        "iat": now,
        "jti": f"ticket-{now}-test",
        "employee_code": "EMP001",
        "portal_session_id": "sess-xyz",
        "target_database": "Test_OperationsDB",
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    claims = sso_session.decode_ticket(token)

    assert claims["employee_code"] == "EMP001"
    assert claims["portal_session_id"] == "sess-xyz"
    assert claims["target_database"] == "Test_OperationsDB"


def test_decode_ticket_expired():
    """Expired launch ticket raises SsoError."""
    now = int(time.time())
    secret = settings.procurement_sso_secret
    payload = {
        "iss": "one-portal",
        "aud": "procurement-dashboard",
        "exp": now - 30,  # expired
        "iat": now - 60,
        "jti": f"ticket-exp-{now}",
        "employee_code": "EMP001",
        "portal_session_id": "sess-xyz",
    }
    token = jwt.encode(payload, secret, algorithm="HS256")

    with pytest.raises(sso_session.SsoError, match="Launch ticket expired"):
        sso_session.decode_ticket(token)


def test_replay_store_prevents_duplicate_tickets():
    """Replay store rejects a ticket with the same JTI."""
    now = int(time.time())
    jti = f"replay-jti-{now}"
    exp = now + 120

    # First consumption succeeds
    assert sso_session.replay_store.consume(jti, exp) is True
    # Second consumption of the same JTI is blocked
    assert sso_session.replay_store.consume(jti, exp) is False


def test_session_cookie_roundtrip():
    """Created session cookie value decodes back to original claims."""
    cookie = sso_session.make_session_cookie_value(
        employee_code="EMP042",
        portal_session_id="portal-sess-99",
        ttl_seconds=3600,
        target_database="OperationsDB",
    )
    assert cookie is not None

    claims = sso_session.read_session_cookie(cookie)
    assert claims is not None
    assert claims["employee_code"] == "EMP042"
    assert claims["session_id"] == "portal-sess-99"
    assert claims["target_database"] == "OperationsDB"
