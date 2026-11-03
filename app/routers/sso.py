"""
SSO router – One Portal ticket launch, login instructions, and logout.

Follows the identical endpoint design as FMS Portal:
- POST /auth/launch: Receives signed ticket from One Portal iframe/redirect.
- GET  /sso/login: User-facing login view.
- GET  /sso/logout: Destroys session cookie and returns to login.
"""
from __future__ import annotations

import html
import logging
from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.auth.sso_session import (
    SESSION_COOKIE,
    SsoError,
    decode_ticket,
    make_session_cookie_value,
    replay_store,
    safe_next_path,
)
from app.config import settings
from app.templates_config import templates

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sso"])


def _error_page(message: str, status_code: int = 401) -> HTMLResponse:
    content = (
        "<!DOCTYPE html><html><head><title>Authentication Error</title>"
        "<link rel='stylesheet' href='https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'>"
        "</head><body class='bg-light d-flex align-items-center' style='min-height: 100vh;'>"
        "<div class='container' style='max-width: 540px;'>"
        "<div class='card shadow-sm border-0 p-4 text-center'>"
        "<h3 class='text-danger mb-3'>Unable to Sign In</h3>"
        f"<p class='text-muted mb-4'>{html.escape(message)}</p>"
        "<p class='small text-secondary'>Please close this window and launch Procurement Dashboard again from HoseXperts One Portal.</p>"
        "<a href='/sso/login' class='btn btn-outline-primary btn-sm mt-2'>Back to Login</a>"
        "</div></div></body></html>"
    )
    return HTMLResponse(content=content, status_code=status_code)


@router.post("/auth/launch")
async def auth_launch(ticket: str = Form(...), next: str = Form("/")):
    """Consume One Portal signed launch ticket and issue local session cookie."""
    try:
        claims = decode_ticket(ticket.strip())
    except SsoError as exc:
        logger.warning("SSO ticket validation failed: %s", exc)
        return _error_page(str(exc), status_code=exc.status_code)

    # Replay protection: each ticket jti can only be used once
    jti = str(claims.get("jti", ""))
    exp = int(claims.get("exp", 0))
    if not replay_store.consume(jti, exp):
        return _error_page("This launch ticket was already used. Please relaunch from One Portal.", 401)

    employee_code = str(claims.get("employee_code", "")).strip()
    portal_session_id = str(claims.get("portal_session_id", "")).strip()
    target_database = str(claims.get("target_database") or settings.api_database).strip()

    if not employee_code or not portal_session_id:
        return _error_page("Launch ticket is incomplete (missing employee or session).", 401)

    ttl = max(300, int(settings.sso_session_minutes) * 60)
    cookie_value = make_session_cookie_value(
        employee_code=employee_code,
        portal_session_id=portal_session_id,
        ttl_seconds=ttl,
        target_database=target_database,
    )

    same_site = (settings.sso_cookie_samesite or "lax").lower()
    if same_site not in {"lax", "strict", "none"}:
        same_site = "lax"

    redirect_target = safe_next_path(next, default="/")
    response = RedirectResponse(url=redirect_target, status_code=303)
    cookie_secure = (same_site == "none") or settings.is_production

    response.set_cookie(
        key=SESSION_COOKIE,
        value=cookie_value,
        max_age=ttl,
        httponly=True,
        secure=cookie_secure,
        samesite=same_site,
        path="/",
    )

    if cookie_secure and same_site == "none":
        response.headers.append(
            "Set-Cookie",
            f"{SESSION_COOKIE}={cookie_value}; Max-Age={ttl}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned",
        )

    logger.info("SSO launch succeeded for employee=%s (db=%s)", employee_code, target_database)
    return response


@router.get("/sso/login")
async def sso_login(request: Request):
    """Display SSO login guidance and status."""
    return templates.TemplateResponse(
        request,
        "login.html",
        {
            "sso_base_url": settings.sso_base_url,
            "one_portal_auth_enabled": settings.one_portal_auth_enabled,
        },
    )


@router.get("/sso/logout")
@router.get("/auth/logout")
async def sso_logout(request: Request):
    """Clear session cookie and redirect to login."""
    response = RedirectResponse(url="/sso/login", status_code=303)
    response.delete_cookie(key=SESSION_COOKIE, path="/")
    return response
