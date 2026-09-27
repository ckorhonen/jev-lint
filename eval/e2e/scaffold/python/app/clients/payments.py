"""Thin wrapper over the payments provider's official Python SDK (synchronous, uses requests)."""

import os
from dataclasses import dataclass

import requests


@dataclass
class Refund:
    id: str
    status: str


class PaymentsClient:
    def __init__(self, api_key: str | None = None, base_url: str = "https://api.payments.example.com/v1"):
        self.api_key = api_key or os.environ["PAYMENTS_API_KEY"]
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {self.api_key}"

    def refund(self, payment_id: str, amount: float) -> Refund:
        resp = self.session.post(f"{self.base_url}/refunds", json={"payment": payment_id, "amount": amount}, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return Refund(id=data["id"], status=data["status"])

    def get_payment(self, payment_id: str) -> dict:
        resp = self.session.get(f"{self.base_url}/payments/{payment_id}", timeout=10)
        resp.raise_for_status()
        return resp.json()
