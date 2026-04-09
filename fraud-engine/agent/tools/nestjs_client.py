"""
Shared HTTP client for all tools that call NestJS endpoints.

Uses httpx.AsyncClient with:
- Connection pooling (reuse across tool calls within one investigation)
- Timeout of 10s (NestJS aggregation queries are fast, but safety margin)
- Structured error handling — tools never crash the graph, they return error dicts
"""
import httpx

from agent.config import NESTJS_BASE_URL


_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=NESTJS_BASE_URL,
            timeout=10.0,
            headers={"Accept": "application/json"},
        )
    return _client


async def nestjs_get(path: str, params: dict | None = None) -> dict:
    """
    GET request to NestJS. Returns parsed JSON or error dict.
    Tools should handle both cases.
    """
    try:
        resp = await get_client().get(path, params=params)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        return {
            "error": True,
            "status_code": e.response.status_code,
            "detail": e.response.text[:500],
        }
    except httpx.RequestError as e:
        return {
            "error": True,
            "status_code": None,
            "detail": f"Connection error: {e}",
        }
