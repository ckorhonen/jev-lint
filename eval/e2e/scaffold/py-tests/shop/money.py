from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


def to_money(value: Decimal | int | str) -> Decimal:
    """Round to whole cents, half away from zero."""
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def format_money(amount: Decimal, currency: str = "USD") -> str:
    symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency, f"{currency} ")
    sign = "-" if amount < 0 else ""
    return f"{sign}{symbol}{abs(to_money(amount)):,.2f}"
