from decimal import Decimal

from shop.money import format_money, to_money


def test_to_money_rounds_half_up():
    assert to_money(Decimal("2.345")) == Decimal("2.35")
    assert to_money(Decimal("-2.345")) == Decimal("-2.35")


def test_format_money():
    assert format_money(Decimal("1234.5")) == "$1,234.50"
    assert format_money(Decimal("-3"), "EUR") == "-€3.00"
