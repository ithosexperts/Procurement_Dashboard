"""
Low-level HTTP client for the HoseXperts Company API (apiv2.php).

All external requests to the company gateway route through this module.
Follows the FMS Portal API integration patterns:
- HTTP request handling via HTTPX
- Bearer token / credential support
- Database target resolution (from request context / settings)
- Table gateway parameter formatting
- JSON error unwrapping and exception raising
"""
from __future__ import annotations

import logging
from typing import Any
import httpx

from app.auth.request_context import get_current_bearer_token, get_current_database_target
from app.config import settings

logger = logging.getLogger(__name__)


class ApiError(Exception):
    """Raised whenever a call to the company API fails or returns an error."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        table: str | None = None,
        raw_error: Any = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.table = table
        self.raw_error = raw_error


def _get_headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    bearer = get_current_bearer_token() or settings.api_auth_token
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    return headers


def _resolve_database(explicit_database: str | None = None) -> str:
    """Resolve target database prioritizing context, then explicit, then settings."""
    if explicit_database and explicit_database in {"Test_OperationsDB", "OperationsDB"}:
        return explicit_database
    context_target = get_current_database_target()
    if context_target:
        return context_target
    return settings.api_database or "Test_OperationsDB"


async def api_request(
    table: str,
    action: str = "select",
    *,
    columns: str = "*",
    where: str = "",
    order_by: str = "",
    limit: int = 0,
    page: int = 0,
    data: dict[str, Any] | None = None,
    database: str | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """
    Send a request to the company REST-style gateway (apiv2.php)
    and return the parsed JSON response.

    Returns dict matching the gateway response contract:
    {
        "status": "success",
        "returnedRows": int,
        "totalRows": int,
        "totalPages": int,
        "currentPage": int,
        "data": list[dict],
    }
    """
    target_db = _resolve_database(database)

    payload: dict[str, Any] = {
        "action": action,
        "table": table,
        "database": target_db,
    }

    if settings.api_username:
        payload["username"] = settings.api_username
    if settings.api_password:
        payload["password"] = settings.api_password

    if columns != "*":
        payload["columns"] = columns
    if where:
        payload["where"] = where
    if order_by:
        payload["order_by"] = order_by
    if limit > 0:
        payload["limit"] = limit
    if page > 0:
        payload["page"] = page
    if data:
        payload["data"] = data

    req_timeout = timeout or settings.api_timeout

    logger.debug(
        "API Request -> table=%s, action=%s, db=%s, limit=%s",
        table,
        action,
        target_db,
        limit,
    )

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(req_timeout, connect=10.0),
            verify=False,
        ) as client:
            resp = await client.post(
                settings.api_base_url,
                json=payload,
                headers=_get_headers(),
            )
            resp.raise_for_status()
            body = resp.json()
    except httpx.HTTPStatusError as exc:
        msg = f"HTTP {exc.response.status_code} error from company API: {exc.response.text[:500]}"
        logger.error(msg)
        raise ApiError(msg, status_code=exc.response.status_code, table=table) from exc
    except httpx.RequestError as exc:
        msg = f"Network failure connecting to company API ({settings.api_base_url}): {exc}"
        logger.error(msg)
        raise ApiError(msg, table=table) from exc
    except ValueError as exc:
        msg = f"Invalid JSON response from company API: {exc}"
        logger.error(msg)
        raise ApiError(msg, table=table) from exc

    # Gateway error validation
    status = str(body.get("status") or "").lower()
    if status == "error" or "error" in body:
        error_msg = body.get("message") or body.get("error") or "Unknown gateway error"
        logger.error("Company API error for table %s: %s", table, error_msg)
        raise ApiError(
            str(error_msg),
            table=table,
            raw_error=body.get("error"),
        )

    return body
