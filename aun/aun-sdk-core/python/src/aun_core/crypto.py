from __future__ import annotations

import base64
import secrets
import time
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec


class CryptoProvider:
    curve_name = "P-256"

    def generate_identity(self) -> dict[str, Any]:
        private_key = ec.generate_private_key(ec.SECP256R1())
        private_pem = private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("utf-8")
        public_der = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return {
            "private_key_pem": private_pem,
            "public_key_der_b64": base64.b64encode(public_der).decode("ascii"),
            "curve": self.curve_name,
        }

    def sign_login_nonce(self, private_key_pem: str, nonce: str, client_time: str | None = None) -> tuple[str, str]:
        key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        used_time = client_time or str(time.time())
        sign_data = f"{nonce}:{used_time}".encode("utf-8")
        signature = key.sign(sign_data, ec.ECDSA(hashes.SHA256()))
        return base64.b64encode(signature).decode("ascii"), used_time

    def new_client_nonce(self) -> str:
        return base64.b64encode(secrets.token_bytes(12)).decode("ascii")
