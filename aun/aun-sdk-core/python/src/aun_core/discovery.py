from __future__ import annotations

from typing import Any

import aiohttp

from .errors import ConnectionError, ValidationError


class GatewayDiscovery:
    def __init__(self, *, verify_ssl: bool = True) -> None:
        self._verify_ssl = verify_ssl

    async def discover(self, well_known_url: str, *, timeout: float = 5.0) -> str:
        try:
            client_timeout = aiohttp.ClientTimeout(total=timeout)
            ssl_param = None if self._verify_ssl else False
            async with aiohttp.ClientSession(timeout=client_timeout) as session:
                async with session.get(well_known_url, ssl=ssl_param) as response:
                    response.raise_for_status()
                    payload: dict[str, Any] = await response.json()
        except Exception as exc:
            raise ConnectionError(
                f"gateway discovery failed for {well_known_url}: {exc}",
                retryable=True,
            ) from exc

        gateways = payload.get("gateways", [])
        if not gateways:
            raise ValidationError("well-known returned empty gateways")

        gateways = sorted(gateways, key=lambda item: item.get("priority", 999))
        url = gateways[0].get("url")
        if not url:
            raise ValidationError("well-known missing gateway url")
        return str(url)
