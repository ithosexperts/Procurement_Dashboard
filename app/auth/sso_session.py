"""
One Portal -> Procurement Dashboard single sign-on helpers.

Follows the identical ticket and session protocol as FMS Portal:
1. One Portal issues an expiring signed JWT ticket.
2. Browser POSTs that ticket to /auth/launch.
3. Dashboard verifies signature, audience, expiry, and single-use jti.
4. Dashboard issues an HttpOnly signed session cookie containing employee_code
   and portal_session_id.
5. Middleware enforces authentication on protected routes.
"""
from __future__ import annotations

import threading
import time
from typing import Any

import jwt

from app.config import settings

PORTAL_ISSUER = "one-portal"
SESSION_ISSUER = "procurement-portal"
SESSION_AUDIENCE = "procurement-session"
ALGORITHM = "HS256"
SESSION_COOKIE = "procurement_sso_session"


class SsoError(Exception):
    def __init__(self, message: str, status_code: int = 401):
        super().__init__(message)
        self.status_code = status_code


def _secret() -> str:
    secret = (settings.procurement_sso_secret or "").strip()
    if len(secret) < 32:
        raise SsoError(
            "PROCUREMENT_SSO_SECRET is not configured or too short (minimum 32 characters).",
            status_code=503,
        )
    return secret


def decode_ticket(ticket: str) -> dict[str, Any]:
    """Decode and validate a One Portal launch ticket."""
    try:
        return jwt.decode(
            ticket,
            _secret(),
            algorithms=[settings.jwt_algorithm or ALGORITHM],
            issuer=PORTAL_ISSUER,
            audience=settings.sso_ticket_audience,
            options={
                "require": ["exp", "iat", "jti", "employee_code", "portal_session_id"]
            },
            leeway=5,
        )
    except jwt.ExpiredSignatureError as exc:
        raise SsoError("Launch ticket expired. Please reopen from One Portal.") from exc
    except jwt.InvalidTokenError as exc:
        raise SsoError("Invalid launch ticket.") from exc


class _ReplayStore:
    """Thread-safe single-use ticket store for JTI replay prevention."""

    def __init__(self) -> None:
        self._used: dict[str, int] = {}
        self._lock = threading.Lock()

    def consume(self, jti: str, exp: int) -> bool:
        now = int(time.time())
        with self._lock:
            # Purge expired entries
            for key, expiry in list(self._used.items()):
                if expiry < now:
                    self._used.pop(key, None)
            if jti in self._used:
                return False
            self._used[jti] = max(exp, now + 60)
            return True


replay_store = _ReplayStore()


def make_session_cookie_value(
    employee_code: str,
    portal_session_id: str,
    ttl_seconds: int,
    target_database: str | None = None,
) -> str:
    """Create a signed session JWT to store inside HttpOnly cookie."""
    now = int(time.time())
    target = str(target_database or "").strip()
    if target not in {"Test_OperationsDB", "OperationsDB"}:
        target = "OperationsDB" if settings.is_production else "Test_OperationsDB"

    return jwt.encode(
        {
            "iss": SESSION_ISSUER,
            "aud": SESSION_AUDIENCE,
            "sub": employee_code,
            "employee_code": employee_code,
            "session_id": portal_session_id,
            "target_database": target,
            "iat": now,
            "nbf": now - 1,
            "exp": now + ttl_seconds,
        },
        _secret(),
        algorithm=settings.jwt_algorithm or ALGORITHM,
    )


def read_session_cookie(value: str | None) -> dict[str, Any] | None:
    """Decode and validate claims from the signed session cookie."""
    value = (value or "").strip()
    if not value or len((settings.procurement_sso_secret or "").strip()) < 32:
        return None
    try:
        return jwt.decode(
            value,
            settings.procurement_sso_secret.strip(),
            algorithms=[settings.jwt_algorithm or ALGORITHM],
            issuer=SESSION_ISSUER,
            audience=SESSION_AUDIENCE,
            options={"require": ["exp", "employee_code", "session_id"]},
            leeway=5,
        )
    except jwt.InvalidTokenError:
        return None


def safe_next_path(value: str | None, default: str = "/") -> str:
    """Validate destination path to block open-redirect attacks."""
    path = (value or "").strip()
    if (
        not path.startswith("/")
        or path.startswith("//")
        or "\\" in path
        or path.startswith("/auth/")
        or path.startswith("/sso/")
        or any(ch in path for ch in "\r\n")
    ):
        return default
    return path
