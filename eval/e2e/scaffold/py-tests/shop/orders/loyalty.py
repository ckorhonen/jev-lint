from decimal import Decimal

from shop.orders.models import Customer


def loyalty_points_for(customer: Customer, total: Decimal) -> int:
    """One point per whole currency unit spent; gold members earn double."""
    base = int(total // 1)
    return base * 2 if customer.loyalty_tier == "gold" else base
