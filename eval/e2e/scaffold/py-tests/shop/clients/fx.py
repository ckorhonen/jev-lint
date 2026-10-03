import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

import httpx

from shop.money import to_money


class FxError(Exception):
    def __init__(self, message: str, status: int, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class UnknownCurrencyError(FxError):
    pass


@dataclass(frozen=True)
class Rates:
    base: str
    as_of: datetime
    rates: dict[str, Decimal]


class FxClient:
    """Client for the RateBridge exchange-rate API v3. Latest rates are cached for `ttl_seconds`."""

    def __init__(
        self,
        api_key: str,
        client: httpx.Client | None = None,
        ttl_seconds: float = 300,
        clock: Callable[[], float] = time.monotonic,
        max_retries: int = 2,
    ):
        self._client = client or httpx.Client(base_url="https://api.ratebridge.example/v3", timeout=5)
        self._headers = {"X-Api-Key": api_key}
        self._ttl = ttl_seconds
        self._clock = clock
        self._max_retries = max_retries
        self._cache: dict[str, tuple[float, Rates]] = {}

    def _get(self, path: str, params: dict[str, str]) -> dict:
        for attempt in range(self._max_retries + 1):
            res = self._client.get(path, params=params, headers=self._headers)
            if res.status_code >= 500 and attempt < self._max_retries:
                continue
            if res.status_code >= 400:
                try:
                    err = res.json()["error"]
                    code, message = err.get("code"), err.get("message", "")
                except (ValueError, KeyError, TypeError):
                    code, message = None, f"RateBridge request failed with HTTP {res.status_code}"
                if code == "unknown_currency":
                    raise UnknownCurrencyError(message, res.status_code, code)
                raise FxError(message, res.status_code, code)
            return res.json()
        raise AssertionError("unreachable")

    def latest(self, base: str = "USD") -> Rates:
        base = base.upper()
        cached = self._cache.get(base)
        if cached and self._clock() - cached[0] < self._ttl:
            return cached[1]
        body = self._get("/latest", {"base": base})
        rates = Rates(
            base=body["base"],
            as_of=datetime.fromisoformat(body["as_of"].replace("Z", "+00:00")),
            rates={cur: Decimal(v) for cur, v in body["rates"].items()},
        )
        self._cache[base] = (self._clock(), rates)
        return rates

    def convert(self, amount: Decimal, from_currency: str, to_currency: str) -> Decimal:
        from_currency, to_currency = from_currency.upper(), to_currency.upper()
        if from_currency == to_currency:
            return to_money(amount)
        rates = self.latest(from_currency)
        if to_currency not in rates.rates:
            raise UnknownCurrencyError(f"no rate for {to_currency}", 404, "unknown_currency")
        return to_money(amount * rates.rates[to_currency])

    def rate_on(self, day: date, base: str, quote: str) -> Decimal | None:
        """Historical rate, or None when RateBridge has no data for that day."""
        try:
            body = self._get(f"/historical/{day.isoformat()}", {"base": base.upper(), "symbols": quote.upper()})
        except FxError as e:
            if e.status == 404 and e.code == "no_data":
                return None
            raise
        value = body["rates"].get(quote.upper())
        return Decimal(value) if value is not None else None
