# aun-core

AUN (Agent Union Network) Protocol Core SDK for Python.

Provides identity management, PKI authentication, key storage, and end-to-end encryption for agent-to-agent communication.

## Features

- **Identity & Authentication** — X.509 certificate-based two-phase challenge-response (ECDSA P-256/P-384)
- **Certificate Verification** — Full chain validation, CRL, OCSP, with caching and parallel verification
- **Key Management** — File-based keystore with platform-native secret protection (Windows DPAPI)
- **End-to-End Encryption** — P256\_HKDF\_SHA256\_AES\_256\_GCM (protocol extensible). Offline prekey-based encryption (four-way ECDH), group E2EE with epoch key management
- **Async Transport** — WebSocket JSON-RPC 2.0, auto-reconnect, heartbeat, token refresh

## Requirements

- Python >= 3.11

## Installation

```bash
pip install aun-core
```

## Quick Start

```python
import asyncio, random
from datetime import datetime
from aun_core import AUNClient

def ts():
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]

# ── Configuration (modify as needed) ──
DOMAIN = "agentid.pub"
ALICE = f"alice{random.randint(1000,9999)}.{DOMAIN}"
BOB = f"bob{random.randint(1000,9999)}.{DOMAIN}"


async def create_client(aid: str) -> tuple[AUNClient, dict]:
    """Create client -> load or create AID -> authenticate -> return (client, auth)"""
    client = AUNClient({"aun_path": f"~/.aun/{aid}"})

    # Try loading existing identity
    identity = client._auth.load_identity_or_none(aid)
    if not identity:
        # Create if not exists
        try:
            await client.auth.create_aid({"aid": aid})
        except Exception as e:
            print(f"Failed to create AID ({aid}): {e}")
            raise

    auth = await client.auth.authenticate({"aid": aid})
    return client, auth


async def main():
    alice = None
    bob = None
    
    try:
        # 1. Create two clients
        alice, alice_auth = await create_client(ALICE)
        bob, bob_auth = await create_client(BOB)

        # 2. Bob subscribes to message events
        received = asyncio.Event()
        def on_bob_message(event):
            print(f"[{ts()}] [Bob received] {event['payload']}")
            received.set()

        bob.on("message.received", on_bob_message)

        # 3. Both connect to gateway
        await alice.connect(alice_auth, {})
        await bob.connect(bob_auth, {})
        print(f"[{ts()}] Alice ({ALICE}) connected")
        print(f"[{ts()}] Bob   ({BOB}) connected")

        # 4. Alice sends a message to Bob
        result = await alice.call("message.send", {
            "to": BOB,
            "type": "text",
            "payload": {"text": "Hello from Alice!"},
        })
        print(f"[{ts()}] [Alice sent] {result}")

        # 5. Wait for Bob to receive the message (up to 5s)
        try:
            await asyncio.wait_for(received.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            # Event push not triggered, try pulling manually
            pull = await bob.call("message.pull", {"after_seq": 0, "limit": 10})
            msgs = pull.get("messages", [])
            if msgs:
                print(f"[{ts()}] [Bob pulled] received {len(msgs)} messages:")
                for m in msgs:
                    print(f"  {m.get('payload')}")
            else:
                print(f"[{ts()}] [Bob] no messages received")

        print(f"[{ts()}] done")
    finally:
        # 6. Close
        if alice:
            await alice.close()
        if bob:
            await bob.close()


asyncio.run(main())
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
