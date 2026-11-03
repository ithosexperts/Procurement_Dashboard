"""
Authentication middleware compatible with One Portal SSO.

Protects routes according to settings.one_portal_auth_enabled.
When auth is enforced, redirects unauthenticated browser requests to /sso/login
and returns 401 for API requests.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth.request_context import (
    AuthenticatedIdentity,
    reset_current_database_target,
    reset_current_identity,
    set_current_database_target,
    set_current_identity,
)
from app.auth.sso_session import SESSION_COOKIE, read_session_cookie
from app.config import settings

logger = logging.getLogger(__name__)

EXCLUDED_PATH_PREFIXES = (
    "/static",
    "/docs",
    "/redoc",
    "/openapi.json",
)

EXCLUDED_PATHS = {
    "/health",
    "/healthz",
    "/favicon.ico",
    "/auth/launch",
    "/sso/login",
    "/sso/logout",
    "/auth/login",
    "/auth/logout",
}


class OnePortalAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        sso_claims = read_session_cookie(request.cookies.get(SESSION_COOKIE))
        target_database = str(
            (sso_claims or {}).get("target_database") or settings.api_database
        ).strip()

        db_context = set_current_database_target(target_database)
        request.state.target_database = target_database

        try:
            return await self._handle_auth(request, call_next, sso_claims)
        finally:
            reset_current_database_target(db_context)

    async def _handle_auth(
        self, request: Request, call_next, sso_claims: dict[str, Any] | None
    ):
        path = request.url.path

        # Public path check
        if path in EXCLUDED_PATHS or any(
            path.startswith(prefix) for prefix in EXCLUDED_PATH_PREFIXES
        ):
            return await call_next(request)

        enforce_auth = bool(settings.one_portal_auth_enabled)

        # Authenticated via One Portal session cookie
        if sso_claims:
            employee_code = str(sso_claims.get("employee_code") or "").strip()
            session_id = str(sso_claims.get("session_id") or "").strip()

            identity = AuthenticatedIdentity(
                session_id=session_id,
                employee_code=employee_code,
                employee_name=sso_claims.get("employee_name") or employee_code,
                email=sso_claims.get("email") or "",
                role_name=sso_claims.get("role_name") or "User",
            )

            request.state.identity = identity
            request.state.employee_code = employee_code
            request.state.session_id = session_id

            id_token = set_current_identity(identity)
            try:
                return await call_next(request)
            finally:
                reset_current_identity(id_token)

        # Unauthenticated request
        if enforce_auth:
            # For JSON API requests, return 401
            accept_header = request.headers.get("accept", "")
            if "application/json" in accept_header or path.startswith("/api/"):
                return JSONResponse(
                    status_code=401,
                    content={
                        "detail": "Not signed in. Open this application from One Portal."
                    },
                )
            # For browser navigations, redirect to login page
            return RedirectResponse(url="/sso/login", status_code=303)

        # Auth not enforced: set dev identity and proceed
        dev_identity = AuthenticatedIdentity(
            session_id="dev-local-session",
            employee_code="DEV001",
            employee_name="Development User",
            email="dev@hosexperts.com",
            role_name="Developer",
        )
        request.state.identity = dev_identity
        request.state.employee_code = dev_identity.employee_code
        request.state.session_id = dev_identity.session_id

        id_token = set_current_identity(dev_identity)
        try:
            return await call_next(request)
        finally:
            reset_current_identity(id_token)
