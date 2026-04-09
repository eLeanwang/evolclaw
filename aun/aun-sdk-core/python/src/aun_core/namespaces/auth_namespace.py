from __future__ import annotations

from typing import Any

from ..errors import ValidationError


class AuthNamespace:
    def __init__(self, client: Any) -> None:
        self._client = client

    async def _resolve_gateway(self, aid: str | None = None) -> str:
        """解析 gateway URL。优先使用已预置的 _gateway_url，否则基于 AID 自动发现。

        发现流程：
        1. 若 _gateway_url 已预置，直接返回
        2. https://{aid}/.well-known/aun-gateway（泛域名 nameservice）
        3. https://gateway.{issuer}/.well-known/aun-gateway（Gateway 直连）
        """
        if self._client._gateway_url:
            return str(self._client._gateway_url)
        resolved_aid = aid or self._client._aid
        if resolved_aid:
            parts = resolved_aid.split(".", 1)
            issuer_domain = parts[1] if len(parts) > 1 else resolved_aid

            port = self._client._config_model.discovery_port
            port_suffix = f":{port}" if port else ""

            primary_url = f"https://{resolved_aid}{port_suffix}/.well-known/aun-gateway"
            try:
                return await self._client._discovery.discover(primary_url)
            except Exception as _exc:
                import logging as _logging
                _logging.getLogger("aun_core").debug("gateway 发现失败: %s", _exc)

            fallback_url = f"https://gateway.{issuer_domain}{port_suffix}/.well-known/aun-gateway"
            return await self._client._discovery.discover(fallback_url)
        raise ValidationError(
            "unable to resolve gateway: set client._gateway_url or provide 'aid' for auto-discovery"
        )

    async def create_aid(self, params: dict[str, Any]) -> dict[str, Any]:
        aid = str((params or {}).get("aid") or "")
        if not aid:
            raise ValueError("auth.create_aid requires 'aid'")
        gateway_url = await self._resolve_gateway(aid)
        self._client._gateway_url = gateway_url
        result = await self._client._auth.create_aid(gateway_url, aid)
        self._client._aid = result["aid"]
        self._client._identity = self._client._auth.load_identity_or_none(result["aid"])
        return {
            "aid": result["aid"],
            "cert_pem": result["cert"],
            "gateway": gateway_url,
        }

    async def authenticate(self, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request = dict(params or {})
        aid = request.get("aid")
        gateway_url = await self._resolve_gateway(aid)
        self._client._gateway_url = gateway_url
        result = await self._client._auth.authenticate(gateway_url, aid=aid)
        self._client._aid = result["aid"]
        self._client._identity = self._client._auth.load_identity_or_none(result["aid"])
        return result  # 已包含 gateway 字段

    async def download_cert(self, params: dict[str, Any] | None = None) -> Any:
        return await self._client.call("auth.download_cert", params or {})

    async def request_cert(self, params: dict[str, Any]) -> Any:
        return await self._client.call("auth.request_cert", params)

    async def renew_cert(self, params: dict[str, Any] | None = None) -> Any:
        return await self._client.call("auth.renew_cert", params or {})

    async def rekey(self, params: dict[str, Any] | None = None) -> Any:
        return await self._client.call("auth.rekey", params or {})

    async def trust_roots(self, params: dict[str, Any] | None = None) -> Any:
        return await self._client.call("meta.trust_roots", params or {})
