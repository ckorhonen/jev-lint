from dataclasses import dataclass
from decimal import Decimal

import httpx


class PaymentError(Exception):
    def __init__(self, message: str, decline_code: str | None = None):
        super().__init__(message)
        self.decline_code = decline_code


@dataclass(frozen=True)
class Charge:
    id: str
    status: str  # "succeeded" | "declined"
    amount: Decimal
    decline_code: str | None = None


class PaymentGateway:
    """Client for the Paywise charges API."""

    def __init__(self, api_key: str, base_url: str = "https://api.paywise.example/v1", client: httpx.Client | None = None):
        self._client = client or httpx.Client(base_url=base_url, timeout=10)
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def charge(self, token: str, amount: Decimal, idempotency_key: str) -> Charge:
        res = self._client.post(
            "/charges",
            json={"source": token, "amount": str(amount), "currency": "usd"},
            headers={**self._headers, "Idempotency-Key": idempotency_key},
        )
        if res.status_code >= 400:
            raise PaymentError(f"charge failed with HTTP {res.status_code}")
        body = res.json()
        return Charge(body["id"], body["status"], Decimal(body["amount"]), body.get("decline_code"))

    def refund(self, charge_id: str) -> None:
        res = self._client.post(f"/charges/{charge_id}/refunds", headers=self._headers)
        if res.status_code >= 400:
            raise PaymentError(f"refund failed with HTTP {res.status_code}")
