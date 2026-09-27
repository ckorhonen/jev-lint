from decimal import ROUND_HALF_UP, Decimal


def line_total(unit_price: Decimal, quantity: int) -> Decimal:
    return (unit_price * quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def order_total(lines: list[tuple[Decimal, int]]) -> Decimal:
    return sum((line_total(price, qty) for price, qty in lines), Decimal("0"))
