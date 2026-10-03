from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal

from shop.pricing.quote import Coupon, QuoteLine, Region


@dataclass(frozen=True)
class Customer:
    id: str
    email: str
    name: str
    region: Region
    loyalty_tier: Literal["standard", "gold"] = "standard"


@dataclass
class Order:
    id: str
    customer_id: str
    lines: list[QuoteLine]
    total: Decimal
    charge_id: str
    created_at: datetime
    status: Literal["paid", "cancelled"] = "paid"
    loyalty_points: int = 0


@dataclass
class PlaceOrder:
    customer: Customer
    lines: list[QuoteLine]
    payment_token: str
    coupon: Coupon | None = None
    metadata: dict[str, str] = field(default_factory=dict)
