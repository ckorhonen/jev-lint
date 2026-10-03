"""Wire types for the RateBridge exchange-rate API v3."""

from typing import TypedDict


class LatestRatesResponse(TypedDict):
    base: str
    as_of: str  # ISO 8601 timestamp
    rates: dict[str, str]  # currency -> decimal string


class HistoricalRateResponse(TypedDict):
    base: str
    date: str  # YYYY-MM-DD
    rates: dict[str, str]


class ErrorResponse(TypedDict):
    error: dict[str, str]  # {"code": ..., "message": ...}
